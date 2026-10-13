"""FO4 Lightbox: local web server. Reads the user's own Fallout 4 install (never writes to it) and serves the viewer.

    python app.py [--game "C:\\...\\Fallout 4"] [--port 8765] [--no-browser]
"""
import argparse
import gzip
import json
import mimetypes
import os
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
import zlib
from collections import OrderedDict
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
# the compiled caches of the viewer's own modules go to %LOCALAPPDATA%\FO4 Lightbox\pycache, never next to the code: a
# mod manager may have put the viewer in the game's Data\Tools folder, and the viewer writes nothing there
sys.pycache_prefix = sys.pycache_prefix or os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'),
                                                        'FO4 Lightbox', 'pycache')
sys.path.insert(0, HERE)
from fo4paths import find_game_dir, sao_settings, shadow_settings        # noqa: E402
from fileshare import Stale, stamp                       # noqa: E402
from vfs import VFS, ArchiveView, lookup_scope, norm     # noqa: E402
from scene import build_scene                            # noqa: E402
import collision                                         # noqa: E402
from fo4nif import Nif                                   # noqa: E402
from materials import read_material                      # noqa: E402

WEB = os.path.join(os.path.dirname(HERE), 'web')
SCENE_DIR = os.path.join(os.path.dirname(HERE), 'scenes')
VERSION = '1.2.0'
BOOT = '%.3f' % time.time()        # changes on every server start: open pages reload themselves (live update)
# gzip level of JSON answers and SceneCache entries: level 2 makes a cold Sanctuary's models + LOD ~2 % larger than 5
# at about half the compression time (the answer waits for it); the page gets the same JSON bytes either way
GZ_LEVEL = 2


_web_stamp = (float('-inf'), '')


def web_stamp():
    """Newest modification time under web/: an edited page file makes open pages reload. Walked at most once a second
    (each open page asks every 1.5 s)."""
    global _web_stamp
    now = time.monotonic()
    if now - _web_stamp[0] < 1.0:
        return _web_stamp[1]
    newest = 0.0
    for dp, dn, fn in os.walk(WEB):
        for f in fn:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(dp, f)))
            except OSError:
                pass
    _web_stamp = (now, '%.3f' % newest)
    return _web_stamp[1]


def file_tag(vfs, path, archives_only=False):
    """Where a resource comes from right now: a loose file by size and modification time, else its archive with the
    archive's own size and date (an archive packed again while the server runs gives its files new tags)."""
    key = norm(path)
    a = vfs.index.get(key)
    if not (archives_only and a):
        lp = vfs.loose_path(key)
        if lp:
            size, mtime_ns = stamp(lp)
            return f'l:{size}:{mtime_ns}'
    return f'a:{a.name}:{a.stamp[0]}:{a.stamp[1]}' if a else '-'


class Recorder:
    """A VFS (or vanilla view) that remembers which files a scene was built from, each tagged (file_tag) just before
    its first read and against this VFS: a file saved while the scene is built leaves an entry that is built again,
    never one that validates stale content (a tag taken after the build would describe the new file)."""

    def __init__(self, v):
        self.v, self.reads = v, {}

    def read(self, path, archives_only=False):
        ao = archives_only or isinstance(self.v, ArchiveView)
        k = (norm(path), ao)
        if k not in self.reads:
            self.reads[k] = file_tag(self.v, k[0], ao)
        return self.v.read(path, archives_only)

    def deps(self):
        return [(k, ao, tag) for (k, ao), tag in sorted(self.reads.items())]

    def __getattr__(self, name):
        return getattr(self.v, name)


def physical_memory():
    """Installed RAM in bytes, or None."""
    try:
        if sys.platform == 'win32':
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                            ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                            ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                            ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                            ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]
            m = MEMORYSTATUSEX()
            m.dwLength = ctypes.sizeof(m)
            return m.ullTotalPhys if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)) else None
        return os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    except (OSError, ValueError, AttributeError):
        return None


def scene_budget():
    """SceneCache size: since distant LOD one cold exterior stores ~45 MB of gzip (Sanctuary: ~26 MB models + ~19 MB
    LOD), so 160 MB held about three places and cycling the place buttons rebuilt seconds of scenes each time. 4 % of
    the RAM, between 160 and 512 MB."""
    ram = physical_memory()
    return max(160 << 20, min(512 << 20, ram // 25)) if ram else 160 << 20


class SceneCache:
    """Scenes already sent, as gzipped JSON, with the files they were built from (the NIF, its BGSM / BGEM
    materials): opening a place again or reloading the page skips parsing, JSON and gzip. An entry whose files
    changed (a fresh export, an edited material) is built again."""

    def __init__(self, budget=160 << 20):
        self.budget, self.size, self.items, self.lock = budget, 0, OrderedDict(), threading.Lock()
        self.building = {}             # key -> Event of the request building it now (claim / release)

    def get(self, key):
        with self.lock:
            e = self.items.get(key)
            if e:
                self.items.move_to_end(key)
        if e and all(file_tag(State.vfs, k, ao) == tag for k, ao, tag in e[1]):
            return e[0]
        return None

    def put(self, key, gz, deps):
        with self.lock:
            old = self.items.pop(key, None)
            if old:
                self.size -= len(old[0])
            self.items[key] = (gz, deps)
            self.size += len(gz)
            while self.size > self.budget and len(self.items) > 1:
                self.size -= len(self.items.popitem(last=False)[1][0])

    def claim(self, key):
        """(event, True) when the caller is to build key; (event, False) while another request builds it: wait for the
        event, then get() again. Two pages asking for one model at once (a live-update reload mid cell load, the
        place-thumbnail renderer beside the page) build it once."""
        with self.lock:
            ev = self.building.get(key)
            if ev is not None:
                return ev, False
            ev = self.building[key] = threading.Event()
            return ev, True

    def release(self, key, ev):
        """The build of key ended (stored or failed): its waiters go on."""
        with self.lock:
            if self.building.get(key) is ev:
                del self.building[key]
        ev.set()

    def clear(self):
        with self.lock:
            self.items.clear()
            self.size = 0
            for ev in self.building.values():       # (waiters build for themselves)
                ev.set()
            self.building.clear()


SCENES = SceneCache(scene_budget())
STATIC = {}                        # page file path -> its bytes, gzip and ETag while unchanged (Handler.static)

CA = 'meshes\\actors\\character\\characterassets\\'
HEAD_M = [CA + 'malehands.nif', CA + 'basemalehead.nif', CA + 'faceparts\\maleheadrear.nif',
          CA + 'faceparts\\maleeyes.nif']
HEAD_F = [CA + 'femalehands.nif', CA + 'basefemalehead.nif', CA + 'faceparts\\femaleheadrear.nif',
          CA + 'faceparts\\femaleeyes.nif']
REFERENCES = {
    'vault_m': dict(label='Vault 111 suit (male)', files=['meshes\\clothes\\vault111suit\\vault111suit.nif'] + HEAD_M),
    'vault_f': dict(label='Vault 111 suit (female)',
                    files=['meshes\\clothes\\vault111suit\\femalevault111suit.nif'] + HEAD_F),
    'body_m': dict(label='Body (male)', files=[CA + 'malebody.nif'] + HEAD_M),
    'body_f': dict(label='Body (female)', files=[CA + 'femalebody.nif'] + HEAD_F),
    # Road Leathers (Armor_Raider_Underarmor, AA_UnderArmor_Raider): a common outfit with its own exposed skin
    'leathers_m': dict(label='Road Leathers (male)',
                       files=['meshes\\armor\\raiderunderarmor\\raiderunderarmorm.nif'] + HEAD_M),
    'leathers_f': dict(label='Road Leathers (female)',
                       files=['meshes\\armor\\raiderunderarmor\\raiderunderarmorf.nif'] + HEAD_F),
}
# Radstag Hide Outfit (Armor_Wastelander_01_GlovesA): the body outfit most NPCs wear by default in Fallout4.esm + DLC
# (82 base NPCs through their default outfits); outfit + gloves, the gloves carry their own fitted hands
REFERENCES['radstag_m'] = dict(label='Radstag Hide Outfit (male)',
                               files=['meshes\\clothes\\wastelander\\outfitm.nif', 'meshes\\clothes\\wastelander\\glovesm.nif'] + HEAD_M[1:])
REFERENCES['radstag_f'] = dict(label='Radstag Hide Outfit (female)',
                               files=['meshes\\clothes\\wastelander\\outfitf.nif', 'meshes\\clothes\\wastelander\\glovesf.nif'] + HEAD_F[1:])
OUTFITS = ('vault', 'leathers', 'radstag')


def _shapes(raw):
    """(name, vertex count) of each mesh shape in a NIF."""
    from fo4nif import Nif
    try:
        return [(b.get('name') or '', b.get('nverts', 0)) for b in Nif(raw).blocks
                if b and b.get('type') in ('BSTriShape', 'BSSubIndexTriShape', 'BSDynamicTriShape')]
    except Exception:
        return []


# a replacer body's shape name says which one it is (CBBE names its body shape "CBBE")
BODY_MOD_NAMES = (('cbbe', 'CBBE'), ('fusiongirl', 'Fusion Girl'), ('bodytalk', 'BodyTalk'), ('atomic', 'Atomic Beauty'))
_body_mods = None


def body_mods():
    """Body replacers installed as loose files (CBBE and the like): per sex, the replacer's name and its files. A loose
    body with the vanilla shapes (same names and vertex counts, e.g. a re-saved copy) is not a replacer."""
    global _body_mods
    if _body_mods is not None:
        return _body_mods
    vfs, out = State.vfs, {}
    for sex, body in (('m', CA + 'malebody.nif'), ('f', CA + 'femalebody.nif')):
        key = norm(body)
        lp = vfs.loose_path(key)
        if not lp or key not in vfs.index:
            continue
        with open(lp, 'rb') as f:
            shapes = _shapes(f.read())
        if shapes == _shapes(vfs.index[key].read(key)):
            continue
        names = [n.lower().replace(' ', '') for n, _ in shapes]
        label = next((lbl for tag, lbl in BODY_MOD_NAMES if any(n.startswith(tag) for n in names)), 'Modded body')
        files = sorted({p for k in ('body',) + OUTFITS for p in REFERENCES[f'{k}_{sex}']['files']
                        if vfs.loose_path(norm(p)) and norm(p) in vfs.index})
        out[sex] = dict(name=label, shapes=[n for n, _ in shapes], files=files)
    _body_mods = out
    return out


class State:
    save_dir = None
    vfs = None
    weather = None
    weather_error = None
    world = None
    world_error = None
    world_gen = 0                  # +1 each time the cell index is built again (a plugin changed on disk)
    world_checked = 0.0
    world_lock = threading.Lock()
    extra_plugins = []             # --plugin: loaded after the load order (a plugin that is not enabled)
    paused = ''                    # files that kept "changing" again and again: automatic checks stopped
    rebuilds = []                  # times of the recent rebuilds (see note_change)
    last_request = time.monotonic()  # --exit-when-idle
    nif_list = None
    lock = threading.Lock()
    list_lock = threading.Lock()   # one mesh listing made at a time (_listing)
    game = None                    # the Fallout 4 folder
    sources = []                   # where the game's files can come from: the game folder, Mod Organizer 2 profiles
    source_auto = False            # the source was picked by the viewer (Mod Organizer 2 found), not by the user
    source_epoch = 0               # +1 each time another source is chosen (cache keys use it)
    switch_lock = threading.Lock()


def load_weather_db():
    try:
        from esm_weather import WeatherDB, DEFAULT_MASTERS
        src = State.vfs.origin
        State.weather = WeatherDB(State.vfs.data, [src.resolve(m) or m for m in DEFAULT_MASTERS])
    except Exception as e:                                  # the viewer still works with built-in neutral light
        State.weather_error = f'{type(e).__name__}: {e}'
        traceback.print_exc()


SKY_DOME = 'meshes\\sky\\atmosphere.nif'


def sky_profile():
    """The sky gradient as the game's dome mesh defines it: per vertex ring, its elevation (degrees, seen from the
    dome's centre) and its vertex colour, whose R, G, B are blend weights for the weather's Horizon, Sky-Lower and
    Sky-Upper colours (docs/engine-notes.md §20). Read from the user's install on request; nothing is stored."""
    import base64
    import math
    import numpy as np
    if getattr(State, 'sky', None) is not None:
        return State.sky
    out = dict(source=SKY_DOME, rings=[])
    try:
        sc = build_scene(State.vfs.read(SKY_DOME, archives_only=True), State.vfs, SKY_DOME, compact=False)
        s = next(x for x in sc['shapes'] if x.get('color'))
        pos = np.frombuffer(base64.b64decode(s['position']), np.float32).reshape(-1, 3)
        col = np.frombuffer(base64.b64decode(s['color']), np.uint8).reshape(-1, 4)
        el = np.degrees(np.arctan2(pos[:, 2], np.linalg.norm(pos[:, :2], axis=1)))
        rings = {}
        for e, c in zip(el, col):
            rings.setdefault(round(float(e), 1), []).append(c[:3])
        for e in sorted(rings):
            w = np.mean(rings[e], axis=0) / 255.0
            out['rings'].append([round(e, 2)] + [round(float(x), 4) for x in w])
    except Exception as e:                                  # the viewer falls back to its own gradient
        out['error'] = f'{type(e).__name__}: {e}'
    State.sky = out
    return out


def plugin_paths():
    """The plugins the cell index reads: the game's load order, then the viewer's own test scenes (scenes\\*.esp,
    Fallout4.esm objects only; they stay in the viewer's folder, nothing goes into Data), then any --plugin."""
    from fo4paths import load_order
    extra = sorted(os.path.join(SCENE_DIR, f) for f in os.listdir(SCENE_DIR)
                   if f.lower().endswith('.esp')) if os.path.isdir(SCENE_DIR) else []
    src = State.vfs.origin                  # (Mod Organizer 2: a plugin may live in a mod's folder)
    return [src.resolve(p) or os.path.join(src.data, p) for p in load_order(src)] + extra + list(State.extra_plugins)


def build_world_db():
    from esm_world import WorldDB
    for attempt in range(5):
        try:
            return WorldDB(State.vfs.data, plugin_paths(), State.vfs)
        except Stale:                       # a plugin was being saved right then: give it a moment
            time.sleep(0.4)
    return WorldDB(State.vfs.data, plugin_paths(), State.vfs)


def load_world_db():
    try:
        w = build_world_db()
        with State.world_lock:
            State.world, State.world_error, State.world_checked = w, None, time.monotonic()
    except Exception as e:
        State.world_error = f'{type(e).__name__}: {e}'
        traceback.print_exc()


SETTLE = 1.5     # seconds a changed plugin must stay unchanged before it is read again (a save may write it in steps)


def plugin_signature(paths):
    """(name, size, mtime) of each plugin as it is on disk now; (name, None, None) when absent."""
    out = []
    for name in paths:
        try:
            out.append((name,) + stamp(os.path.join(State.vfs.data, name)))
        except OSError:
            out.append((name, None, None))
    return tuple(out)


def world(force=False):
    """The cell / record index, built again when the load order changed or a plugin was saved since it was read (the
    CK or FO4Edit saving while the viewer runs), once the files have been left alone for SETTLE seconds: the next
    cell opened shows the plugin as it is now. The check is a stat per plugin, at most once a second.
    force: build it again right away if anything changed (a read found a plugin changed under it)."""
    w = State.world
    if w is None or (not force and (State.paused or time.monotonic() - State.world_checked < 1.0)):
        return w
    with State.world_lock:
        if State.world is not w:                       # another request rebuilt it meanwhile
            return State.world
        now = State.world_checked = time.monotonic()
        try:
            sig = plugin_signature(plugin_paths())
        except OSError:
            return w
        if sig == w.signature:
            State.world_pending = None
            return w
        pend = getattr(State, 'world_pending', None)
        if pend is None or pend[0] != sig:              # changed (again): wait until it stays as it is
            State.world_pending = pend = (sig, now)
        if not force and now - pend[1] < SETTLE:
            return w
        t = time.time()
        try:
            nw = build_world_db()
        except Exception as e:
            State.world_error = f'{type(e).__name__}: {e}'
            traceback.print_exc()
            return w
        old, new = {x[0]: x[1:] for x in w.signature}, {x[0]: x[1:] for x in sig}
        names = sorted(os.path.basename(n) for n in old.keys() | new.keys() if old.get(n) != new.get(n))
        State.world, State.world_error, State.world_pending = nw, None, None
        State.world_gen += 1
        State.world_checked = time.monotonic()
        w.close()
        print(f'  plugins changed on disk ({short_list(names)}): cell index read again in {time.time() - t:.1f} s',
              flush=True)
        note_change(names)
        return nw


def plural(n, word):
    return f'{n} {word}' + ('' if n == 1 else 's')


def short_list(names, n=4):
    return ', '.join(names[:n]) + (f' and {len(names) - n} more' if len(names) > n else '') if names else 'load order'


def note_change(names):
    """Guard against files that only seem to change (a file system that answers differently each time it is asked):
    the same files read again 4 times within 30 s stop the automatic checks; File > Reload game files still reads
    changes on demand. (Real edits, such as mods switched on and off in Mod Organizer 2, change other files.)"""
    now, what = time.monotonic(), frozenset(names)
    State.rebuilds = [(t, w) for t, w in State.rebuilds if now - t < 30] + [(now, what)]
    if sum(w == what for _, w in State.rebuilds) >= 4 and not State.paused:
        State.paused = short_list(names)
        State.vfs.auto = False
        print(f'  WARNING: game files keep changing on disk ({State.paused}). Automatic reload is paused; '
              'use File > Reload game files in the viewer. Please report this with the names above.', flush=True)


def archives_changed(names):
    print(f'  archives changed on disk ({short_list(names)}): read again', flush=True)
    note_change(names)


def reload_game_files():
    """File > Reload game files: read whatever changed on disk now, and start the automatic checks again."""
    State.paused, State.rebuilds = '', []
    State.vfs.auto = True
    before = data_generation()
    State.vfs.refresh(force=True, rescan=True)     # Mod Organizer 2: files added to a mod's folder since
    world(force=True)
    return before != data_generation()


def archive_signature(vfs):
    """CRC of the source and of every mounted archive's name, size and date. Part of status data_gen, which the page
    puts into archived files' URLs (cached by the browser for an hour): VFS.generation starts at 0 on every server
    start, so an archive packed again between two runs needs its own stamp in there."""
    h = zlib.crc32(vfs.origin.id.encode())
    for a in vfs.archives:
        h = zlib.crc32(('|%s:%d:%d' % (a.name, a.stamp[0], a.stamp[1])).encode(), h)
    return h


def data_generation():
    """Changes whenever the game data the viewer reads changed on disk (archives repacked, plugins saved) or another
    source was chosen: open pages use it to drop what they cached."""
    world()
    State.vfs.refresh()
    return f'{State.source_epoch}.{State.vfs.generation}.{State.world_gen}'


# ---- where the game's files come from: the game folder or a Mod Organizer 2 profile (sources.py, mo2.py) -------------

def settings_dir():
    return os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), 'FO4 Lightbox')


def read_settings():
    try:
        with open(os.path.join(settings_dir(), 'settings.json'), encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def write_settings(**changes):
    d = read_settings()
    d.update(changes)
    try:
        os.makedirs(settings_dir(), exist_ok=True)
        tmp = os.path.join(settings_dir(), 'settings.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(d, f, indent=1)
        os.replace(tmp, os.path.join(settings_dir(), 'settings.json'))
    except OSError:
        pass


def discover_sources(game):
    """(sources, the Mod Organizer 2 instances found, the instance folder MO2 started this viewer from or None)."""
    from sources import GameFolder
    from mo2 import find_instances, profiles_of
    try:
        insts, started = find_instances(read_settings().get('mo2_folders', []))
    except Exception:                                   # MO2's files unreadable: the game folder still works
        traceback.print_exc()
        insts, started = [], None
    return ([GameFolder(game)] if game else []) + profiles_of(insts), insts, started


def pick_source(srcs, insts, started, want=None):
    """The source to start with: asked for (--source/--mo2), the instance MO2 started the viewer from, the user's
    last choice, else Mod Organizer 2's current profile when MO2 is set up for Fallout 4, else the game folder.
    Returns (source, picked by the viewer itself)."""
    from mo2 import current_instance
    by_id = {s.id: s for s in srcs}

    def selected(inst):
        mine = [s for s in srcs if s.kind == 'mo2' and s.inst is inst]
        return next((s for s in mine if s.profile.lower() == inst.selected.lower()), mine[0] if mine else None)
    if want == 'game':
        return next((s for s in srcs if s.kind == 'game'), srcs[0]), False
    if want and want != 'mo2' and want in by_id:
        return by_id[want], False
    if started and want != 'mo2':
        inst = next((i for i in insts if os.path.normcase(i.folder) == started), None)
        if inst and selected(inst):
            return selected(inst), False
    saved = read_settings().get('source')
    if want != 'mo2' and saved in by_id:
        return by_id[saved], False
    cur = current_instance()
    for inst in sorted(insts, key=lambda i: not (not i.portable and i.name == cur)):     # MO2's current one first
        s = selected(inst)
        if s and (want == 'mo2' or s.in_use()):        # (an instance made once and left without mods: not used)
            return s, want != 'mo2'
    return next((s for s in srcs if s.kind == 'game'), srcs[0]), False


def describe_source(src):
    d = src.describe()
    d['current'] = State.vfs is not None and src.id == State.vfs.origin.id
    return d


def rediscover():
    """Look for Mod Organizer 2 profiles again (a profile or instance made since the start); the source in use stays
    the same object."""
    srcs, _, _ = discover_sources(State.game)
    cur = State.vfs.origin
    State.sources = [cur if s.id == cur.id else s for s in srcs]
    if cur.id not in {s.id for s in State.sources}:
        State.sources.append(cur)


def sources_answer(rediscover_first=False):
    if rediscover_first:
        rediscover()
    return dict(sources=[describe_source(s) for s in State.sources], current=State.vfs.origin.id,
                auto=State.source_auto)


def mo2_line(src):
    from mo2 import read_modlist
    n = sum(os.path.isdir(os.path.join(src.inst.mods_dir, m)) for m in read_modlist(os.path.join(src.pdir,
                                                                                                   'modlist.txt')))
    return f'  Mod Organizer 2: profile "{src.profile}" of {src.inst.name} ({plural(n, "mod")} enabled), {src.inst.folder}'


def use_source(src, save=True):
    """Read the game's files from another source: its archives, loose files and plugins, then drop everything cached
    from the one before. The pages notice the new data version and load again."""
    global _body_mods
    with State.switch_lock:
        t = time.time()
        if src.kind == 'mo2':
            print(mo2_line(src), flush=True)
        src.loose_index = None                          # read the profile as it is now
        vfs = VFS(src)
        vfs.on_change, vfs.auto = archives_changed, State.vfs.auto if State.vfs else True
        old = State.vfs
        weather_again = old is None or os.path.normcase(old.game_dir) != os.path.normcase(vfs.game_dir)
        State.vfs = vfs
        with State.world_lock:
            w = State.world
            try:
                State.world, State.world_error = build_world_db(), None
            except Exception as e:
                State.world, State.world_error = None, f'{type(e).__name__}: {e}'
                traceback.print_exc()
            State.world_gen += 1
            State.world_checked, State.world_pending = time.monotonic(), None
            if w is not None:
                w.close()
        if weather_again:
            State.weather, State.weather_error = None, None
            load_weather_db()
        with State.lock:
            State.nif_list, State.hkx_list, State.game_names, State.sky = None, None, None, None
            _body_mods = None
        SCENES.clear()
        try:
            import anim
            anim._skeleton_cache.clear()
        except Exception:
            pass
        State.source_epoch += 1
        State.source_auto = False
        State.paused, State.rebuilds = '', []
        if save:
            write_settings(source=src.id)
        what = f'Mod Organizer 2 profile "{src.profile}" ({plural(len(src.mods), "mod")}, {len(src.loose_index):,} loose files)' \
            if src.kind == 'mo2' else 'the game folder'
        print(f'  now reading {what}: {len(vfs.archives)} archives in {time.time() - t:.1f} s', flush=True)
    threading.Thread(target=nif_list, daemon=True).start()


def _listing(attr, exts):
    """The sorted mesh-folder keys with these extensions for the current VFS and generation, kept in State.<attr>.
    Made outside State.lock (a listing walks Data for ~0.3 s; the lock also guards the source switch and the game
    names); list_lock lets one request make it while the others wait for that one."""
    with State.list_lock:
        with State.lock:
            vfs = State.vfs
            gen = (vfs, vfs.generation)                 # (another source is another VFS)
            cur = getattr(State, attr, None)
            if cur is not None and cur[0] == gen:
                return cur[1]
        lst = vfs.list_files('meshes', exts)
        with State.lock:
            if State.vfs is vfs:                        # (not after a source switch: that one lists again)
                setattr(State, attr, (gen, lst))
        return lst


def nif_list():
    return _listing('nif_list', ('.nif',))


def game_names():
    """Mesh path -> (the in-game name to show, searchable text: every name and EDID of the armour using it)."""
    w = world()
    if not w:
        return {}
    with State.lock:
        cached = getattr(State, 'game_names', None)
    if cached is not None and cached[0] is w:
        return cached[1]
    out = {}
    for k, lst in w.model_names().items():
        out[k] = ([n for n, e in lst], ' '.join('%s %s' % (n, e) for n, e in lst).lower())
    State.game_names = (w, out)
    return out


_search = {}                       # id(pool) -> the mesh search's haystacks and last query (search_pool)
_search_lock = threading.Lock()


def search_pool(pool, names, terms):
    """The pool's keys matching every term in the key or in the in-game names' text, in pool order. A term holds no
    whitespace, so 'in key + newline + text' is the same test as 'in key or in text'; the haystacks are made once per
    pool and names (a new listing or index brings new objects). A query that only narrows the last one (each earlier
    term inside a new term: typing on) filters the last result instead of the whole pool (~220,000 paths)."""
    with _search_lock:
        s = _search.get(id(pool))
        if s is None or s['pool'] is not pool or (s['names'] is not names and (names or s['names'])):
            if len(_search) >= 2:                       # (the meshes and the animations)
                _search.clear()
            s = _search[id(pool)] = dict(pool=pool, names=names, last=None,
                                         hay=[k + '\n' + names[k][1] if k in names else k for k in pool])
        hay, last = s['hay'], s['last']
    idx = range(len(hay))
    if last is not None and all(any(o in t for t in terms) for o in last[0]):
        idx = last[1]
    found = [i for i in idx if all(t in hay[i] for t in terms)]
    with _search_lock:
        if _search.get(id(pool)) is s:
            s['last'] = (terms, found)
    return [pool[i] for i in found]


def game_name(entry, terms):
    """The name to show for a mesh: the first one the search terms match, else the first."""
    return next((n for n in entry[0] if all(t in n.lower() for t in terms)), entry[0][0])


def hkx_list():
    return _listing('hkx_list', ('.hkx',))



# ------------------------------------------------------------------------------------------------ Open with
# FO4 Lightbox.exe <file.nif> (a double-click on a .nif, Windows' Open with) hands the file to the viewer: /api/open
# queues it, the open page asks /api/opens about once a second and loads it. A file the game sees at its own game path
# (loose in Data or in a Mod Organizer 2 mod) opens by that path, with its materials and textures as for any game
# mesh; any other file (an export folder) is read like a dropped file (/api/openfile), its textures from the game.
OPENS = {'lock': threading.Lock(), 'next': 1, 'items': [], 'files': {}, 'seen': -1e9, 'title': ''}
APP_DIR = os.path.dirname(HERE)


def open_target(path):
    """The game path of a file when the game sees exactly this file there, else None."""
    p = os.path.normcase(os.path.abspath(path))
    parts = p.split(os.sep)
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == 'meshes':
            rel = '\\'.join(parts[i:])
            try:
                lp = State.vfs.loose_path(norm(rel))
            except Exception:
                lp = None
            if lp and os.path.normcase(os.path.abspath(lp)) == p:
                return rel
            break
    return None


def open_with(on):
    """Windows' Open with list for .nif files, for this user (no admin rights): FO4 Lightbox.exe "<file>". Windows
    leaves the default app to the user (Open with > Always use this app), so NifSkope or any default stays as it is."""
    import winreg
    import ctypes
    exe = os.path.normpath(os.path.join(APP_DIR, 'FO4 Lightbox.exe'))
    cls = r'Software\Classes'
    keys = [cls + r'\FO4Lightbox.nif\shell\open\command', cls + r'\FO4Lightbox.nif\shell\open',
            cls + r'\FO4Lightbox.nif\shell', cls + r'\FO4Lightbox.nif\DefaultIcon', cls + r'\FO4Lightbox.nif',
            cls + r'\Applications\FO4 Lightbox.exe\shell\open\command', cls + r'\Applications\FO4 Lightbox.exe\shell\open',
            cls + r'\Applications\FO4 Lightbox.exe\shell', cls + r'\Applications\FO4 Lightbox.exe\SupportedTypes',
            cls + r'\Applications\FO4 Lightbox.exe']
    H = winreg.HKEY_CURRENT_USER
    if on:
        if not os.path.isfile(exe):
            raise FileNotFoundError('FO4 Lightbox.exe is not next to the viewer (running from the source folder?)')
        cmd = f'"{exe}" "%1"'

        def put(key, name, value, kind=winreg.REG_SZ):
            with winreg.CreateKeyEx(H, key, 0, winreg.KEY_WRITE) as k:
                winreg.SetValueEx(k, name, 0, kind, value)
        put(cls + r'\FO4Lightbox.nif', '', 'NIF mesh')
        put(cls + r'\FO4Lightbox.nif\DefaultIcon', '', f'"{exe}",0')
        put(cls + r'\FO4Lightbox.nif\shell\open\command', '', cmd)
        put(cls + r'\.nif\OpenWithProgids', 'FO4Lightbox.nif', b'', winreg.REG_NONE)
        put(cls + r'\Applications\FO4 Lightbox.exe', 'FriendlyAppName', 'FO4 Lightbox')
        put(cls + r'\Applications\FO4 Lightbox.exe\shell\open\command', '', cmd)
        put(cls + r'\Applications\FO4 Lightbox.exe\SupportedTypes', '.nif', '')
    else:
        try:
            with winreg.OpenKey(H, cls + r'\.nif\OpenWithProgids', 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, 'FO4Lightbox.nif')
        except OSError:
            pass
        for key in keys:                         # (deepest first)
            try:
                winreg.DeleteKey(H, key)
            except OSError:
                pass
    ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)      # SHCNE_ASSOCCHANGED: Explorer reads it again
    return open_with_state()


def open_with_state():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\FO4Lightbox.nif\shell\open\command') as k:
            cmd = winreg.QueryValueEx(k, '')[0]
        return dict(on=True, command=cmd)
    except (OSError, ImportError):
        return dict(on=False, exe=os.path.isfile(os.path.join(APP_DIR, 'FO4 Lightbox.exe')))



def collision_of(raw, placed):
    """A NIF's collision bodies (collision.nif_collision); placed: drawn at a cell reference, where (as build_scene)
    the reference places the root and the root's own transform is not used."""
    nif = Nif(raw)
    if placed:
        for r in nif.roots:
            if 0 <= r < nif.nblocks and 'local' in nif.blocks[r]:
                nif.blocks[r]['local'] = collision.np.eye(4)
    return collision.nif_collision(nif)

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        if '--verbose' in sys.argv:
            super().log_message(fmt, *args)

    def send(self, code, body, ctype='application/json', cache=False):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, separators=(',', ':')).encode()
        elif isinstance(body, str):
            body = body.encode()
        gz = 'gzip' in self.headers.get('Accept-Encoding', '') and len(body) > 2048 and \
             (ctype.startswith('application/json') or ctype.startswith('text') or ctype.endswith('javascript'))
        if gz:
            body = gzip.compress(body, GZ_LEVEL)
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        if gz:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Cache-Control', 'max-age=3600' if cache else 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def error(self, code, msg):
        self.send(code, {'error': msg})

    def send_gz(self, gz):
        """A JSON body that is already gzipped (SceneCache)."""
        body, enc = (gz, True) if 'gzip' in self.headers.get('Accept-Encoding', '') else (gzip.decompress(gz), False)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if enc:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def send_scene(self, key, build):
        """build(vfs recorder) -> JSON dict; answered from SceneCache while its files are unchanged."""
        key = (State.source_epoch,) + key          # (a scene of the source before is never served for another)
        gz = SCENES.get(key)
        if gz is None:
            ev, mine = SCENES.claim(key)
            if not mine:                            # being built by another request: use its result
                ev.wait(600)
                gz = SCENES.get(key)
            try:
                if gz is None:                      # (also when that build failed: this request tries itself)
                    vfs = State.vfs
                    rec = Recorder(vfs)
                    body = build(rec)
                    deps = rec.deps()
                    if isinstance(body, dict):      # the files it was built from, as they were (Reload materials)
                        body['deps'] = {('v:' if ao else '') + k: tag for k, ao, tag in deps}
                    gz = gzip.compress(json.dumps(body, separators=(',', ':')).encode(), GZ_LEVEL)
                    if State.vfs is vfs:            # another source chosen meanwhile: its files are not these
                        SCENES.put(key, gz, deps)
            finally:
                if mine:
                    SCENES.release(key, ev)
        self.send_gz(gz)

    def do_GET(self):
        State.last_request = time.monotonic()
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path.startswith('/api/'):
                try:
                    with lookup_scope():                # loose-override lookups answered once per request (vfs.py)
                        return self.api(u.path[5:], q)
                except Stale:                           # a plugin or archive was saved under this request: again
                    State.vfs.refresh(force=True)
                    world(force=True)
                    try:
                        with lookup_scope():
                            return self.api(u.path[5:], q)
                    except Stale as e:                  # still being written: the page asks again later
                        return self.error(503, f'{e}: it is being saved right now, try again in a moment')
            return self.static(u.path)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            return                                      # the page went away (reload, closed tab): nothing to answer
        except FileNotFoundError as e:
            return self.error(404, f'not found: {e}')
        except Exception as e:
            traceback.print_exc()
            return self.error(500, f'{type(e).__name__}: {e}')

    def do_POST(self):
        State.last_request = time.monotonic()
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            n = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(n)
            if u.path == '/api/nif':
                return self.send(200, build_scene(body, State.vfs, q.get('name', 'dropped.nif')))
            if u.path == '/api/collision':              # a dropped / imported NIF's collision
                return self.send(200, collision_of(body, False))
            if u.path == '/api/devsave':                # calibration helper; only when started with --save-dir
                if not State.save_dir:
                    return self.error(403, 'saving is off (start the server with --save-dir <folder>)')
                name = os.path.basename(q.get('name', 'render.png'))
                if not name.lower().endswith(('.png', '.json')):
                    name += '.png'
                with open(os.path.join(State.save_dir, name), 'wb') as f:
                    f.write(body)
                return self.send(200, {'saved': os.path.join(State.save_dir, name)})
            return self.error(404, 'unknown endpoint')
        except Exception as e:
            traceback.print_exc()
            return self.error(500, f'{type(e).__name__}: {e}')

    def static(self, path):
        """A page file. Kept (with its gzip) while its size and date stay the same, sent with an ETag and no-cache: a
        reload costs a 304 per unchanged file, and an edited file is sent at once (live update)."""
        if path in ('', '/'):
            path = '/index.html'
        full = os.path.normpath(os.path.join(WEB, path.lstrip('/')))
        try:
            inside = os.path.commonpath([full, WEB]) == WEB      # (not a sibling folder whose name starts with web)
        except ValueError:                                      # another drive
            inside = False
        if not inside or not os.path.isfile(full):
            return self.error(404, 'no such page')
        with open(full, 'rb') as f:
            st = os.fstat(f.fileno())
            e = STATIC.get(full)
            if e is None or e['stamp'] != (st.st_mtime_ns, st.st_size):
                ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
                if full.endswith('.js'):
                    ctype = 'text/javascript'
                e = dict(stamp=(st.st_mtime_ns, st.st_size), raw=f.read(), ctype=ctype, gz=None,
                         tag='"w:%x:%x"' % (st.st_mtime_ns, st.st_size))
                STATIC[full] = e
        if self.headers.get('If-None-Match') == e['tag']:
            self.send_response(304)
            self.send_header('ETag', e['tag'])
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            return
        body, ctype = e['raw'], e['ctype']
        gz = 'gzip' in self.headers.get('Accept-Encoding', '') and len(body) > 2048 and \
            (ctype.startswith('application/json') or ctype.startswith('text') or ctype.endswith('javascript'))
        if gz:
            if e['gz'] is None:
                e['gz'] = gzip.compress(body, 9)            # (once per version of the file)
            body = e['gz']
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        if gz:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('ETag', e['tag'])
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def api(self, ep, q):
        vfs = State.vfs
        if ep == 'open':                                # FO4 Lightbox.exe <file.nif>: hand a file to the viewer
            fp = os.path.abspath(q.get('path', ''))
            if not fp.lower().endswith('.nif') or not os.path.isfile(fp):
                return self.error(404, f'not a NIF file: {fp}')
            rel = open_target(fp)
            with OPENS['lock']:
                item = dict(id=OPENS['next'], name=os.path.basename(fp), rel=rel, t=time.monotonic())
                OPENS['next'] += 1
                OPENS['items'] = OPENS['items'][-19:] + [item]
                OPENS['files'][item['id']] = fp
            # page: an open page asked lately (a minimised one asks about once a minute); title: its window's title
            return self.send(200, dict(id=item['id'], rel=rel, page=time.monotonic() - OPENS['seen'] < 75,
                                       title=OPENS['title']))
        if ep == 'opens':                               # the page: files handed over since `after` (0: the last 2 min, a page still starting)
            OPENS['seen'] = time.monotonic()
            OPENS['title'] = q.get('title', '')[:300]
            after, now = int(q.get('after') or 0), time.monotonic()
            items = [dict(id=i['id'], name=i['name'], rel=i['rel']) for i in OPENS['items']
                     if i['id'] > after and (after or now - i['t'] < 120)]
            return self.send(200, dict(items=items))
        if ep == 'openfile':                            # a handed-over file outside the game's folders, as bytes
            fp = OPENS['files'].get(int(q.get('id') or 0))
            if not fp or not os.path.isfile(fp):
                return self.error(404, 'that file is no longer there')
            with open(fp, 'rb') as f:
                return self.send(200, f.read(), 'application/octet-stream')
        if ep == 'openwith':                            # File > Open .nif files with Lightbox (Windows' Open with)
            if 'set' not in q:
                return self.send(200, open_with_state())
            try:
                return self.send(200, open_with(q['set'] == '1'))
            except Exception as e:
                return self.error(500, str(e))
        if ep == 'version':
            return self.send(200, dict(boot=BOOT, web=web_stamp(), data=data_generation(), paused=State.paused))
        if ep == 'ready':                               # FO4 Lightbox.exe's splash: what has finished loading
            return self.send(200, dict(weather=State.weather is not None or State.weather_error is not None,
                                       world=State.world is not None or State.world_error is not None,
                                       meshes=State.nif_list is not None))
        if ep == 'reload':
            changed = reload_game_files()
            return self.send(200, dict(changed=changed, data=data_generation()))
        if ep == 'sources':                             # the Mods menu: the game folder and every MO2 profile found
            return self.send(200, sources_answer(rediscover_first=True))
        if ep == 'source':                              # read the game's files from another source
            src = next((s for s in State.sources if s.id == q.get('id')), None)
            if src is None:
                rediscover()
                src = next((s for s in State.sources if s.id == q.get('id')), None)
            if src is None:
                return self.error(404, 'that source is no longer there')
            if src.id != vfs.origin.id or q.get('again') == '1':
                use_source(src)
            elif State.source_auto:
                write_settings(source=src.id)          # kept: the user confirmed the one picked for them
                State.source_auto = False
            return self.send(200, dict(sources_answer(), data=data_generation()))
        if ep == 'source/add':                          # Mods > Add a Mod Organizer 2 folder (one not found by itself)
            from mo2 import instance_folder, Instance
            folder = instance_folder(q.get('path', ''))
            if not folder:
                return self.error(400, 'No ModOrganizer.ini in that folder. Paste the folder that holds '
                                       'ModOrganizer.exe (portable) or the instance folder.')
            inst = Instance(folder)
            if not inst.is_fallout4():
                return self.error(400, f'That Mod Organizer 2 instance is set up for {inst.game_name or "another game"}'
                                       ', not Fallout 4 (its game folder has no Data\\Fallout4.esm).')
            have = read_settings().get('mo2_folders', [])
            if os.path.normcase(folder) not in {os.path.normcase(f) for f in have}:
                write_settings(mo2_folders=have + [folder])
            return self.send(200, sources_answer(rediscover_first=True))
        if ep == 'status':
            return self.send(200, dict(version=VERSION, game_dir=vfs.game_dir, source=describe_source(vfs.origin),
                                       source_auto=State.source_auto, archives=[a.name for a in vfs.archives],
                                       unused_archives=[os.path.basename(p) for p in vfs.unused_archives],
                                       archive_errors=vfs.errors, files=len(vfs.index),
                                       data_gen='%08x.%d' % (archive_signature(vfs), vfs.generation),
                                       data=data_generation(),
                                       weather=State.weather is not None, weather_error=State.weather_error,
                                       references={k: v['label'] for k, v in REFERENCES.items()},
                                       body_mods=body_mods(), sao=sao_settings(vfs.origin),
                                       light_shadows=shadow_settings(vfs.origin)))
        if ep == 'search':
            terms = [t for t in q.get('q', '').lower().replace('/', '\\').split() if t]
            limit = int(q.get('limit', 400))
            pool = hkx_list() if q.get('kind') == 'hkx' else nif_list()
            # meshes also by the in-game name of the armour / clothing that uses them ("synth chest piece")
            names = game_names() if q.get('kind') != 'hkx' else {}
            found = search_pool(pool, names, terms)

            # best first: the in-game name, terms in the file name (at its start best), common categories, short names
            def rank(k):
                name = k.rsplit('\\', 1)[-1]
                s = 0.0
                gn = names.get(k)
                if gn and terms and all(t in gn[1] for t in terms):
                    s += 4 + (1 if gn[1].startswith(terms[0]) else 0)
                for t in terms:
                    if name.startswith(t):
                        s += 3
                    elif t in name:
                        s += 2
                if '\\armor\\' in k or '\\clothes\\' in k or '\\weapons\\' in k:
                    s += 0.5
                if '\\lod\\' in k or '\\markers\\' in k or '1stperson' in k:
                    s -= 1
                if k.endswith('.hkx'):                  # clips that drive the human body first
                    if '\\character\\animations\\' in k:
                        s += 1.5
                    elif '\\powerarmor\\' in k:
                        s += 0.3
                return (-s, len(name), k)
            found.sort(key=rank)
            res = found[:limit]
            return self.send(200, dict(results=res, matches=len(found), total=len(pool),
                                       names={k: game_name(names[k], terms) for k in res if k in names}))
        if ep == 'nif':
            # swap: comma-separated MSWP FormIDs from a plugin record, applied to the material paths (read only when
            # the scene is built: a cached one does not wait for the index lock a cell() in progress holds)
            W = world() if q.get('swap') else None
            swap_ids = [s for s in q.get('swap', '').split(',') if s]
            saved = W.swap_changed(swap_ids) if W else None
            if saved:                               # a cached scene must not outlive its swaps: rebuild the index
                raise Stale(f'{saved} changed on disk')

            def swap_map():
                return W.swap_map(swap_ids) if W else None
            if 'file' in q:                         # a NIF outside Data (fresh export); capture/dev mode only
                if not State.save_dir:
                    return self.error(403, 'reading files outside Data needs the server started with --save-dir')
                fp = os.path.abspath(q['file'])
                if not fp.lower().endswith('.nif') or not os.path.isfile(fp):
                    return self.error(404, f'not a NIF file: {fp}')
                swaps = swap_map()
                with open(fp, 'rb') as f:
                    sc = build_scene(f.read(), vfs, os.path.basename(fp), swaps)
                sc['source'] = 'file'
                return self.send(200, sc)
            path = q['path']
            vanilla = q.get('vanilla') == '1'
            placed = q.get('placed') == '1'        # drawn at a cell reference: the root's own transform is not used
            cut = tuple(float(v) for v in q['cut'].split(',')) if q.get('cut') else None     # distant LOD (world.js)
            if cut and len(cut) != 4:
                return self.error(400, 'cut needs x0,y0,x1,y1')

            def build(rec):
                v = ArchiveView(rec) if vanilla else rec      # vanilla: archived mesh, materials and textures
                sc = build_scene(v.read(path), v, norm(path), swap_map(), placed=placed, cut=cut)
                sc['source'] = 'archive' if vanilla and norm(path) in vfs.index else vfs.source(path)
                if sc['source'] == 'loose' and vfs.origin.mod_of(norm(path)):
                    sc['mod'] = vfs.origin.mod_of(norm(path))      # Mod Organizer 2: the mod it comes from
                sc['vanilla'] = vanilla
                return sc
            # material swaps come from a plugin: a cached scene with swaps is only good for the index it was read from
            return self.send_scene(('nif', norm(path), vanilla, q.get('swap', ''), State.world_gen if W else 0, placed,
                                    cut), build)
        if ep == 'collision':                       # a NIF's Havok collision as plain shapes (game mode, physics)
            path = q['path']
            placed = q.get('placed') == '1'

            def build(rec):
                return collision_of(rec.read(path), placed)
            return self.send_scene(('collision', norm(path), placed), build)
        if ep == 'armors':
            W = world()
            if not W:
                return self.send(200, dict(items=[], matches=0, error=State.world_error or 'indexing the load order…'))
            items, n = W.armor_search(q.get('q', ''), int(q.get('limit', 150)))
            return self.send(200, dict(items=items, matches=n))
        if ep == 'armor':
            W = world()
            if not W:
                return self.error(503, State.world_error or 'world index not ready')
            return self.send(200, W.armor(q['id']))
        if ep == 'reference':
            ref = REFERENCES[q['id']]
            vanilla = q.get('vanilla', '1') == '1'
            # the default look of the Player (male) / Nora (female) record: hair, hairline, beard, hair colour, and the
            # eyes' wet layer, lid shadow and lashes (with the eyes, whether or not the hair is shown)
            W = world()
            look = W.default_look(q['id'][-1]) if W else {'parts': [], 'eye_parts': []}
            eyes = look.get('eye_parts', []) if any('eyes.nif' in f for f in ref['files']) else []
            if q.get('hair', '1') != '1':
                look = dict(look, parts=[])
            extra = [x for x in eyes + look['parts'] if x not in ref['files']]
            files = [p for p in ref['files'] + extra if vfs.exists(p)]

            def build(rec):
                v = ArchiveView(rec) if vanilla else rec      # vanilla: a body mod's loose files are skipped entirely
                parts = []
                for p in files:
                    hair = p in look['parts']
                    sc = build_scene(v.read(p), v, p, remap=look.get('hair_remap') if hair else None)
                    sc['source'] = 'archive' if vanilla and norm(p) in vfs.index else vfs.source(p)
                    sc['vanilla'] = vanilla
                    parts.append(sc)
                return dict(id=q['id'], label=ref['label'], parts=parts, hair_color=look.get('hair_color'))
            key = ('ref', q['id'], vanilla, tuple(files), json.dumps(look.get('hair_remap')), json.dumps(look.get('hair_color')))
            return self.send_scene(key, build)
        if ep == 'clips':
            from anim import CLIPS
            return self.send(200, dict(clips=[dict(c, available=vfs.exists(c['path'])) for c in CLIPS]))
        if ep == 'anim':
            from anim import load_clip
            return self.send(200, load_clip(vfs, q['path'], q.get('in_place') == '1'), cache=True)
        if ep == 'cells':
            W = world()
            if not W:
                return self.send(200, dict(cells=[], matches=0, error=State.world_error or 'indexing the load order…'))
            cells, n = W.search(q.get('q', ''), int(q.get('limit', 200)))
            return self.send(200, dict(cells=cells, matches=n))
        if ep == 'cell':
            W = world()
            if not W:
                return self.error(503, State.world_error or 'world index not ready')
            out = W.cell(q['id'], max(0, min(3, int(q.get('r', 1)))))
            lt = out.get('lighting')
            if lt and lt.get('imagespace') and State.weather:
                try:
                    out['imagespace'] = State.weather.get_imagespace(lt['imagespace'])
                except Exception as e:
                    out['imagespace_error'] = str(e)
            return self.send(200, out)
        if ep == 'door':                            # a load door's destination: the cell its door stands in
            W = world()
            if not W:
                return self.error(503, State.world_error or 'world index not ready')
            try:
                out = W.door_cell(q['ref'])
            except KeyError as e:
                return self.error(404, str(e))
            # an exterior destination: the grid cell under where the player appears (the door itself is a persistent
            # reference of the worldspace's persistent cell)
            pos = [float(v) for v in q.get('pos', '').split(',') if v] if q.get('pos') else None
            if not out['interior'] and pos and len(pos) >= 2 and out.get('world'):
                g = W.grid.get((int(out['world'], 16), int(pos[0] // 4096), int(pos[1] // 4096)))
                if g is not None:
                    gc = W.cells[g]
                    out = dict(out, cell='%08X' % g, edid=gc['edid'] or out['edid'], name=gc['name'] or out['name'])
            return self.send(200, out)
        if ep == 'sky':
            return self.send(200, sky_profile())
        if ep == 'skintones':
            W = world()
            if not W:
                return self.error(503, State.world_error or 'world index not ready')
            return self.send(200, W.skin_tones())
        if ep == 'skeleton':
            from anim import SKELETON_NIF
            sc = build_scene(vfs.read(SKELETON_NIF, archives_only=q.get('vanilla', '1') == '1'), vfs, SKELETON_NIF)
            return self.send(200, dict(nodes=sc['nodes']), cache=True)
        if ep == 'file':
            path, ao = q['path'], q.get('vanilla') == '1'
            tag = '"%s"' % file_tag(vfs, path, ao).replace('"', '')
            if tag != '"-"' and self.headers.get('If-None-Match') == tag:
                self.send_response(304)
                self.send_header('ETag', tag)
                self.send_header('Cache-Control', 'max-age=3600' if tag.startswith('"a:') else 'no-cache')
                self.end_headers()
                return
            data = vfs.read(path, archives_only=ao)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('ETag', tag)
            # archived files cannot change while the server runs; loose ones (a texture being edited) are asked for
            # again every time, so the edit shows on the next load (an unchanged file costs a 304)
            self.send_header('Cache-Control', 'max-age=3600' if tag.startswith('"a:') else 'no-cache')
            self.end_headers()
            self.wfile.write(data)
            return
        if ep == 'exists':
            return self.send(200, {p: vfs.source(p) for p in q.get('paths', '').split('|') if p})
        if ep == 'tags':
            # Reload materials & textures: where each file comes from right now (a loose file's size and date, or its
            # archive's); 'v:' asks for the archived copy. An archive packed again since is indexed again first.
            vfs.refresh(force=True)
            out = {}
            for p in q.get('paths', '').split('|'):
                if p:
                    ao = p.startswith('v:')
                    out[p] = file_tag(vfs, p[2:] if ao else p, ao)
            return self.send(200, out)
        if ep == 'material':
            return self.send(200, read_material(vfs.read(q['path'])))
        if ep == 'weather/presets':
            if not State.weather:
                return self.send(200, dict(presets=[], error=State.weather_error or 'weather data not loaded'))
            return self.send(200, dict(presets=State.weather.presets()))
        if ep == 'weather/list':
            if not State.weather:
                return self.send(200, dict(weathers=[]))
            return self.send(200, dict(weathers=State.weather.list_weathers()))
        if ep == 'weather/sample':
            if not State.weather:
                return self.error(503, State.weather_error or 'weather data not loaded')
            w = q['id']
            hour = float(q.get('hour', 12))
            clim = q.get('climate') or None
            return self.send(200, State.weather.sample(w, hour, clim))
        if ep == 'weather/get':
            return self.send(200, State.weather.get_weather(q['id']))
        return self.error(404, 'unknown endpoint')


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second server bind the same port and both answer at random (a page then reloads
    # over and over). Without it a second start is refused, and a restart can still bind at once.
    allow_reuse_address = os.name != 'nt'

    def handle_error(self, request, client_address):
        # the browser dropped a connection (page reload, closed tab, a live-update poll cut short): not an error
        if isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def lightbox_at(port):
    """True if FO4 Lightbox already answers on this port."""
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/version', timeout=2) as r:
            return 'boot' in json.load(r)
    except (OSError, ValueError):
        return False


def bind(port):
    """The server socket, or None if this port already runs the viewer. A port that is in use for another reason is
    tried again for a few seconds (a restart: the old server may still be letting go), then reported."""
    for attempt in range(25):
        try:
            return Server(('127.0.0.1', port), Handler)
        except OSError as e:
            if e.errno not in (10048, 10013, 98, 13) and getattr(e, 'winerror', None) not in (10048, 10013):
                raise
        if attempt in (0, 24) and lightbox_at(port):
            return None
        time.sleep(0.2)
    print(f'Port {port} is used by another program. Start again with another port, e.g. --port {port + 1}')
    sys.exit(1)


# the install, when it had to be typed in once (not found by itself): asked in the console and kept in settings_dir(),
# the file the launcher keeps the folder picked in its dialog in. Up to 1.1.0 the console kept it next to the viewer.
GAME_FILE = os.path.join(settings_dir(), 'game_path.txt')
OLD_GAME_FILE = os.path.join(os.path.dirname(HERE), 'game_path.txt')


def remembered_game():
    for p in (GAME_FILE, OLD_GAME_FILE):
        try:
            with open(p, encoding='utf-8') as f:
                g = f.readline().strip()
            if g:
                return g
        except OSError:
            pass
    return None


def ask_game_dir():
    if not (sys.stdin and sys.stdin.isatty() and sys.stdout and sys.stdout.isatty()):
        return None                                   # started by a tool, not by a person: nobody to ask
    print('Fallout 4 was not found by itself.')
    for _ in range(3):
        try:
            p = input('Paste your Fallout 4 folder (the one that holds Data) and press Enter: ').strip().strip('"')
        except (EOFError, KeyboardInterrupt):
            return None
        game = find_game_dir(p) if p else None          # (nothing else is found: the search before came up empty)
        if game:
            try:
                os.makedirs(settings_dir(), exist_ok=True)
                with open(GAME_FILE, 'w', encoding='utf-8') as f:
                    f.write(game + '\n')
            except OSError:
                pass
            return game
        print('  There is no Data\\Fallout4.esm in that folder.')
    return None


def exit_when_idle(srv, seconds):
    """Stop the server once no page has asked anything for `seconds` (the window was closed). An open page asks
    every 1.5 s, and still about once a minute while its window is minimised. Time the PC spent asleep does not count:
    on waking, the page has had no chance to ask yet."""
    tick = min(5.0, seconds / 4)
    last = time.monotonic()
    while True:
        time.sleep(tick)
        now = time.monotonic()
        if now - last > tick * 3:                # this thread slept far longer than asked: the PC was asleep
            State.last_request = now
        last = now
        if now - State.last_request > seconds:
            print(f'  no page has been open for {seconds:.0f} s: stopping', flush=True)
            srv.shutdown()
            return


def main():
    ap = argparse.ArgumentParser(description='FO4 Lightbox - Fallout 4 NIF viewer')
    ap.add_argument('--game', help='Fallout 4 folder (the one containing Data); auto-detected if omitted')
    ap.add_argument('--port', type=int, default=8765, help='local port (default 8765); only this PC can connect')
    ap.add_argument('--no-browser', action='store_true', help='do not open the browser')
    ap.add_argument('--verbose', action='store_true', help='log every request')
    ap.add_argument('--exit-when-idle', type=float, default=0, metavar='SECONDS',
                    help='stop when no page has asked anything for this long (FO4 Lightbox.exe uses 180)')
    ap.add_argument('--save-dir', help='calibration: folder where the page may save renders (off by default)')
    ap.add_argument('--plugin', action='append', default=[], metavar='FILE',
                    help='also read this plugin after the load order (one that is not enabled); repeatable')
    ap.add_argument('--source', metavar='game|mo2',
                    help='read the game folder as it is (game) or a Mod Organizer 2 profile (mo2); by default a '
                         'Mod Organizer 2 set up for Fallout 4 is found and used, and the last choice is kept')
    ap.add_argument('--mo2', metavar='FOLDER', help='a Mod Organizer 2 instance (or portable MO2) folder to read')
    ap.add_argument('--profile', help='with --mo2: the profile to read (default: the one selected in MO2)')
    a = ap.parse_args()
    State.extra_plugins = [os.path.abspath(x) for x in a.plugin]
    if a.save_dir:
        os.makedirs(a.save_dir, exist_ok=True)
        State.save_dir = os.path.abspath(a.save_dir)
    if a.mo2:
        from mo2 import instance_folder
        folder = instance_folder(a.mo2)
        if not folder:
            print(f'No Mod Organizer 2 instance (ModOrganizer.ini) in {a.mo2}')
            sys.exit(1)
        have = read_settings().get('mo2_folders', [])
        if os.path.normcase(folder) not in {os.path.normcase(f) for f in have}:
            write_settings(mo2_folders=have + [folder])
    game = find_game_dir(a.game or remembered_game())
    srcs, insts, started = discover_sources(game)
    if not game and insts:                              # not installed where it is looked for: MO2 knows where it is
        game = insts[0].game_dir
        srcs, insts, started = discover_sources(game)
    game = game or ask_game_dir()
    if not game:
        print('Fallout 4 was not found. Run again with --game "<path to the Fallout 4 folder>".')
        sys.exit(1)
    if not srcs:
        srcs, insts, started = discover_sources(game)
    want = a.source
    if a.mo2:
        mine = [s for s in srcs if s.kind == 'mo2' and os.path.normcase(s.inst.folder) == os.path.normcase(folder)]
        pick = next((s for s in mine if a.profile and s.profile.lower() == a.profile.lower()), None) or \
            next((s for s in mine if s.profile.lower() == s.inst.selected.lower()), None) or (mine[0] if mine else None)
        if pick is None:
            print(f'{folder} is not a Mod Organizer 2 instance for Fallout 4 (or has no profile).')
            sys.exit(1)
        want = pick.id
    srv = bind(a.port)
    url = f'http://127.0.0.1:{a.port}/'
    if srv is None:
        print(f'FO4 Lightbox is already running: {url}')
        if not a.no_browser:
            webbrowser.open(url)
        return
    src, State.source_auto = pick_source(srcs, insts, started, want)
    State.game, State.sources = game, srcs
    t = time.time()
    print(f'FO4 Lightbox {VERSION}: {src.game_dir}', flush=True)
    if src.kind == 'mo2':
        print(mo2_line(src), flush=True)
    elif insts:
        n = len(srcs) - 1
        why = 'as chosen' if 'game' in (a.source, read_settings().get('source')) else 'its profile has no mods enabled'
        print(f'  Mod Organizer 2 found ({n} profile{"s" if n != 1 else ""}): reading the game folder ({why}); '
              'the Mods menu switches', flush=True)
    State.vfs = VFS(src)
    State.vfs.on_change = archives_changed
    if src.kind == 'mo2':
        print(f'  {plural(len(src.mods), "mod")}: {len(src.loose_index):,} loose files indexed', flush=True)
    print(f'  {len(State.vfs.archives)} archives, {len(State.vfs.index):,} archived files indexed in {time.time() - t:.1f} s')
    for e in State.vfs.errors:
        print('  archive error:', e)
    threading.Thread(target=load_weather_db, daemon=True).start()
    threading.Thread(target=load_world_db, daemon=True).start()
    threading.Thread(target=nif_list, daemon=True).start()
    print(f'  open {url}   (Ctrl+C to stop)')
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    if a.exit_when_idle:
        threading.Thread(target=exit_when_idle, args=(srv, a.exit_when_idle), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
