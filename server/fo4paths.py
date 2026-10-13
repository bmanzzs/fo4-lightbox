"""Locate a Fallout 4 installation and the files that decide which archives the game loads.

Nothing here is specific to one machine: the install comes from (in order) an explicit argument, the
FO4_DATA environment variable, the Bethesda registry key, Steam's library folders, then GOG Galaxy's registry keys.
"""
import os
import re
import sys

from fileshare import exists


def _lines(path):
    """A text file's lines, read and closed at once (nothing in the game folder stays open). UTF-8, else the system's
    ANSI code page (Mod Organizer 2 writes plugins.txt in it, so a plugin name with an accent stays readable)."""
    with open(path, 'rb') as f:
        raw = f.read()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('mbcs' if sys.platform == 'win32' else 'cp1252', 'replace')
    return text.splitlines(True)


def _registry_install():
    if sys.platform != 'win32':
        return None
    try:
        import winreg
    except ImportError:
        return None
    for hive, key in ((winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Bethesda Softworks\Fallout4'),
                      (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Bethesda Softworks\Fallout4')):
        try:
            with winreg.OpenKey(hive, key) as k:
                path, _ = winreg.QueryValueEx(k, 'installed path')
                if path and os.path.isdir(path):
                    return path
        except OSError:
            pass
    return None


def _reg_value(hive, key, name):
    try:
        import winreg
        with winreg.OpenKey(hive, key) as k:
            return winreg.QueryValueEx(k, name)[0]
    except (ImportError, OSError):
        return None


def _steam_libraries():
    roots = []
    if sys.platform == 'win32':
        import winreg
        p = _reg_value(winreg.HKEY_CURRENT_USER, r'Software\Valve\Steam', 'SteamPath')     # Steam on another drive
        if p:
            roots.append(os.path.normpath(p))
    for base in (os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramFiles')):
        if base:
            roots.append(os.path.join(base, 'Steam'))
    libs, seen = [], set()
    for steam in roots:
        if os.path.normcase(steam) in seen:
            continue
        seen.add(os.path.normcase(steam))
        vdf = os.path.join(steam, 'steamapps', 'libraryfolders.vdf')
        if os.path.isfile(vdf):
            libs.append(steam)
            text = ''.join(_lines(vdf))
            libs += [p.replace('\\\\', '\\') for p in re.findall(r'"path"\s+"([^"]+)"', text)]
    unique = {}
    for p in libs:
        unique.setdefault(os.path.normcase(os.path.normpath(p)), p)
    return list(unique.values())


def _gog_installs():
    """Folders of the games GOG Galaxy installed (find_game_dir keeps the one holding Data\\Fallout4.esm)."""
    out = []
    if sys.platform != 'win32':
        return out
    import winreg
    for key in (r'SOFTWARE\WOW6432Node\GOG.com\Games', r'SOFTWARE\GOG.com\Games'):
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key) as k:
                for i in range(winreg.QueryInfoKey(k)[0]):
                    p = _reg_value(winreg.HKEY_LOCAL_MACHINE, key + '\\' + winreg.EnumKey(k, i), 'path')
                    if p:
                        out.append(p)
        except OSError:
            pass
    return out


def _own_install():
    """The game this viewer was installed into by a mod manager (Vortex puts it in <game>\\Data\\Tools\\FO4 Lightbox),
    or None."""
    p = os.path.dirname(os.path.abspath(__file__))
    while True:
        up = os.path.dirname(p)
        if up == p:
            return None
        if os.path.basename(p).lower() == 'data' and os.path.isfile(os.path.join(p, 'Fallout4.esm')):
            return up
        p = up


def find_game_dir(explicit=None):
    """Return the Fallout 4 game folder (the one that contains Data), or None."""
    cands = []
    if explicit:
        cands.append(explicit)
    if os.environ.get('FO4_DATA'):
        cands.append(os.path.dirname(os.path.normpath(os.environ['FO4_DATA'])))
    own = _own_install()
    if own:
        cands.append(own)
    reg = _registry_install()
    if reg:
        cands.append(reg)
    for lib in _steam_libraries():
        cands.append(os.path.join(lib, 'steamapps', 'common', 'Fallout 4'))
    cands += _gog_installs()
    for c in cands:
        c = os.path.normpath(c)
        if os.path.basename(c).lower() == 'data':
            c = os.path.dirname(c)
        if os.path.isfile(os.path.join(c, 'Data', 'Fallout4.esm')):
            return c
    return None


def my_games_dir():
    home = os.path.expanduser('~')
    docs = []
    if sys.platform == 'win32':                     # Documents moved to another drive or into OneDrive
        import winreg
        p = _reg_value(winreg.HKEY_CURRENT_USER,
                       r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders', 'Personal')
        if p:
            docs.append(os.path.expandvars(p))
    docs += [os.path.join(home, 'Documents'), os.path.join(home, 'OneDrive', 'Documents')]
    for p in (os.path.join(d, 'My Games', 'Fallout4') for d in docs):
        if os.path.isdir(p):
            return p
    return None


def _ini_lists(path):
    """{lower key: [names]} for the archive list settings in one ini file."""
    out = {}
    if not os.path.isfile(path):
        return out
    for line in _lines(path):
        m = re.match(r'\s*(sResource\w*List\d?)\s*=\s*(.*)', line, re.I)
        if m:
            out[m.group(1).lower()] = [s.strip() for s in m.group(2).split(',') if s.strip()]
    return out


SAO_KEYS = {'bsaoenable': 'enable', 'fsaoradius': 'radius', 'fsaobias': 'bias', 'fsaointensity': 'intensity'}
# shadows of placed lights: map resolution, filter (1 tap / 3 x 3 / 16 taps), the distance from the camera over which a
# light's map halves its resolution, the shadow distance
SHADOW_KEYS = {'ishadowmapresolution': 'resolution', 'uishadowfilter': 'filter', 'flocalshadowmaphalveeveryxunit':
               'halve_every', 'fshadowdistance': 'distance'}


def display_settings(src, keys):
    """[Display] values (keys: lower-case INI name -> our name) as the game reads them: Fallout4_Default.ini, then the
    source's Fallout4.ini, Fallout4Prefs.ini and Fallout4Custom.ini (later files win). {} when none is found."""
    from sources import as_source
    src = as_source(src)
    files = [os.path.join(src.game_dir, 'Fallout4_Default.ini')]
    ini_dir = src.ini_dir()
    if ini_dir:
        files += [os.path.join(ini_dir, n) for n in ('Fallout4.ini', 'Fallout4Prefs.ini', 'Fallout4Custom.ini')]
    out = {}
    for path in files:
        if not os.path.isfile(path):
            continue
        section = ''
        for line in _lines(path):
            line = line.strip()
            if line.startswith('['):
                section = line.strip('[]').strip().lower()
                continue
            m = re.match(r'([A-Za-z]\w*)\s*=\s*([-+0-9.eE]+)', line)
            if section == 'display' and m and m.group(1).lower() in keys:
                try:
                    out[keys[m.group(1).lower()]] = float(m.group(2))
                except ValueError:
                    pass
    return out


def sao_settings(src):
    """The game's screen-space ambient occlusion settings ([Display] bSAOEnable, fSAORadius, fSAOBias, fSAOIntensity)."""
    return display_settings(src, SAO_KEYS)


def shadow_settings(src):
    """The game's shadow settings used for placed lights (SHADOW_KEYS)."""
    return display_settings(src, SHADOW_KEYS)


OFFICIAL_MASTERS = ['Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm',
                    'DLCworkshop03.esm', 'DLCNukaWorld.esm', 'DLCUltraHighResolution.esm']


def load_order(src):
    """Plugin file names in load order: official masters, Creation Club (Fallout4.ccc), then the enabled entries of
    the source's plugins.txt. src: a source (sources.py) or the game folder."""
    from sources import as_source
    src = as_source(src)
    resolve = src.resolver() if hasattr(src, 'resolver') else src.resolve      # (one listing for all the names)
    order = [p for p in OFFICIAL_MASTERS if resolve(p)]
    ccc = os.path.join(src.game_dir, 'Fallout4.ccc')
    if os.path.isfile(ccc):
        for line in _lines(ccc):
            p = line.strip()
            if p and resolve(p) and p not in order:
                order.append(p)
    ptxt = src.plugins_txt()
    if ptxt and os.path.isfile(ptxt):
        low = {p.lower() for p in order}
        for line in _lines(ptxt):
            line = line.strip()
            if line.startswith('*'):
                p = line[1:]
                if p.lower() not in low and resolve(p):
                    order.append(p)
                    low.add(p.lower())
    return order


def archive_order(src):
    """BA2 files in the order the game mounts them (later entries override earlier ones): the archive lists of the
    game's INI files, then each active plugin's own archives in load order. src: a source (sources.py) or the game
    folder.

    Returns (ordered list of absolute paths, list of archives present that the game would not load)."""
    from sources import as_source
    src = as_source(src)
    present = src.top_files('.ba2')                     # lower name -> (name, path), higher priority winning
    lists = _ini_lists(os.path.join(src.game_dir, 'Fallout4_Default.ini'))
    ini_dir = src.ini_dir()
    if ini_dir:
        for name in ('Fallout4.ini', 'Fallout4Custom.ini'):
            lists.update(_ini_lists(os.path.join(ini_dir, name)))
    names = []
    for key in ('sresourcestartuparchivelist', 'sresourceindexfilelist', 'sresourcearchivelist',
                'sresourcearchivelist2'):
        names += lists.get(key, [])
    for plugin in load_order(src):
        base = os.path.splitext(plugin)[0].lower() + ' - '
        names += sorted(f for lf, (f, _) in present.items() if lf.startswith(base))
    ordered, seen = [], set()
    for n in names:
        hit = present.get(n.lower())
        if hit and n.lower() not in seen:
            seen.add(n.lower())
            ordered.append(hit[1])
    unused = sorted(path for lf, (f, path) in present.items() if lf not in seen)
    return ordered, unused
