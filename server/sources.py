"""Where the game's files come from.

GameFolder: the game's own Data folder (and plugins.txt in %LOCALAPPDATA%\\Fallout4), what the game reads when it is
started normally or through Vortex (which links its mods into Data).

MO2Profile (mo2.py): a Mod Organizer 2 profile read directly from its files: the game's Data folder with the profile's
enabled mods merged over it in priority order and the Overwrite folder on top, the profile's plugins.txt, and the
profile's own game INI files when it has them. The same view MO2's virtual Data folder gives the game, without running
inside it.

A source answers: where is the game, which folders make up Data (lowest priority first), which plugins.txt and game
INI folder apply, and where a top-level file (plugin, archive) lives.
"""
import os

from fileshare import exists, under_usvfs


def my_games_dir():
    from fo4paths import my_games_dir as mg
    return mg()


class GameFolder:
    kind = 'game'

    def __init__(self, game_dir):
        self.game_dir = game_dir
        self.data = os.path.join(game_dir, 'Data')
        self.id = 'game'
        self.label = 'Game folder'
        self.detail = game_dir
        self.loose_index = None             # loose files are looked up in Data directly

    def roots(self):
        """The folders that make up Data, lowest priority first."""
        return [self.data]

    def plugins_txt(self):
        local = os.environ.get('LOCALAPPDATA')
        return os.path.join(local, 'Fallout4', 'plugins.txt') if local else None

    def ini_dir(self):
        return my_games_dir()

    def resolve(self, name):
        """A top-level Data file (plugin, archive) by name: its path, or None."""
        p = os.path.join(self.data, name)
        return p if exists(p) else None

    def resolver(self):
        """resolve() for a batch of names (a load order), see listed_resolver."""
        return listed_resolver(self.resolve, [self.data])

    def top_files(self, ext):
        """{lower-case name: (name, path)} of the top-level Data files with this extension, higher priority winning."""
        out = {}
        for root in self.roots():
            try:
                names = os.listdir(root)
            except OSError:
                continue
            for f in names:
                if f.lower().endswith(ext):
                    out[f.lower()] = (f, os.path.join(root, f))
        return out

    def watch(self):
        """Files whose change means the source itself changed (mod list, profile plugin list)."""
        return []

    def load(self):
        """Read what the source is made of (MO2: the mod list and its loose files). Nothing to read here."""

    def changed(self):
        """True when load() should run again (MO2: the profile was saved)."""
        return False

    def mod_of(self, key):
        """The mod a loose file comes from (MO2), else None."""
        return None

    def describe(self):
        return dict(id=self.id, kind=self.kind, label=self.label, detail=self.detail, game_dir=self.game_dir)


def _plain(name):
    # a name the file system can only find under its own spelling, case aside: no folders, short (8.3) names,
    # streams, or trailing dots / spaces (Windows drops those), and ASCII (lower() folds case as NTFS does)
    return name.isascii() and not any(c in name for c in '\\/:~') and name == name.rstrip('. ')


def listed_resolver(resolve, dirs, known=()):
    """resolve(name) for many names in a row: the folders are listed once and a plain name in none of them is absent
    without asking the file system (Fallout4.ccc names every Creation Club plugin, most of them not installed: a
    failing lookup each, twice per live-update poll). Names that are listed, or not plain, still go through resolve().
    Inside MO2's virtual file system (a listing may not show what opens) every name goes through resolve()."""
    if under_usvfs():
        return resolve
    present = set(k.lower() for k in known)
    for d in dirs:
        try:
            present.update(f.lower() for f in os.listdir(d))
        except OSError:
            return resolve

    def res(name):
        if _plain(name) and name.lower() not in present:
            return None
        return resolve(name)
    return res


def as_source(src):
    """A source object from a source or a game folder path (older callers pass the path)."""
    return GameFolder(src) if isinstance(src, str) else src
