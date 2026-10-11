"""Read Fallout 4 weather, climate and imagespace records directly from the game's master files.

FO4 Lightbox lights its scenes with the game's own numbers: the colour sets, directional ambient, fog and
imagespace (HDR / cinematic) values come from WTHR, CLMT, IMGS and GDRY records in Fallout4.esm and the
DLC masters, read here without xEdit, the Creation Kit or any other tool at runtime.

Only the Python standard library is used. The plugin format handled here is the FO4 one: a TES4 header,
a tree of GRUPs, 24-byte record headers, zlib-compressed record bodies (flag 0x00040000, the body starts
with the u32 decompressed size) and 6-byte subrecord headers, with XXXX carrying the size of an oversized
subrecord.

Field layouts follow FO4Edit 4.1.5f's definitions (exported with `FO4Export -q raw`) and were checked
value by value against FO4Dump's decoded output; docs/weather-notes.md describes the comparison and says
what is verified and what is inferred (notably the time-of-day timing scheme).

Two views of the data are offered:
  * get_weather() / get_climate() / get_imagespace(): the decoded records, keyed with FO4Edit's field
    names so a value can be looked up side by side with xEdit. Colours are 0-255 integers as stored.
  * sample(): the values blended for one game hour for a renderer: colours are the stored bytes / 255
    (not linearised), imagespace numbers are raw; every sample carries a 'units' block saying so.

Usage:
    db = WeatherDB(r'...\\Fallout 4\\Data')
    s = db.sample('CommonwealthClear', 12.0)
"""
import copy
import mmap
import os
import struct
import sys
import zlib

from fileshare import SharedFile, Stale, exists, fstamp, open_shared

__all__ = ['WeatherDB', 'TOD_STORAGE', 'TOD_CHRONO', 'NAM0_SLOTS', 'PRESET_EDIDS', 'DEFAULT_MASTERS']

DEFAULT_MASTERS = ('Fallout4.esm', 'DLCRobot.esm', 'DLCCoast.esm', 'DLCNukaWorld.esm')

# --------------------------------------------------------------------------------------------------------
# Times of day
# --------------------------------------------------------------------------------------------------------

# Order of the eight time-of-day entries inside every per-time structure (NAM0 colours, PNAM cloud colours,
# JNAM cloud alphas, IMSP imagespaces, WGDR god rays and the eight DALC subrecords). The first four are the
# Skyrim set; FO4 appended the other four. Same order in FO4Edit's definitions and in the CK's string table.
TOD_STORAGE = ('Sunrise', 'Day', 'Sunset', 'Night', 'EarlySunrise', 'LateSunrise', 'EarlySunset', 'LateSunset')

# The same entries in the order they occur through a day.
TOD_CHRONO = ('Night', 'EarlySunrise', 'Sunrise', 'LateSunrise', 'Day', 'EarlySunset', 'Sunset', 'LateSunset')

# Where, as a fraction of a climate's sunrise window (0 = begin, 1 = end), each of the five sunrise-side colour
# sets is at full strength: Night, EarlySunrise, Sunrise, LateSunrise, Day. The sunset side is the mirror image
# (Day, EarlySunset, Sunset, LateSunset, Night). CALIBRATED on one in-game shot (docs/weather-notes.md §11):
# EarlySunrise at the window's begin, Day at its end, the sets a third apart, and the Night ramp one more third
# before the window. With DefaultClimate (sunrise 05:00-09:00) 07:00 is half Sunrise, half LateSunrise, which
# reproduced the game's 07:00 sunlight; the earlier quarter scheme (Night at begin) was half an hour late.
# Kept in one place so a verified scheme only changes this line.
TOD_WINDOW_FRACTIONS = (-1 / 3, 0.0, 1 / 3, 2 / 3, 1.0)

# Records with only the four Skyrim-era times of day (four vanilla weathers, form versions 40-109, e.g.
# DefaultWeather): how sample() completes them, after the FO4_Base_Library prior art (UNVERIFIED against
# the engine). Colours: per-byte average of the two neighbouring sets. Imagespace / god-ray slots: a copy
# of Sunrise or Sunset.
_SHORT_AVERAGE = {'EarlySunrise': ('Night', 'Sunrise'), 'LateSunrise': ('Sunrise', 'Day'),
                  'EarlySunset': ('Day', 'Sunset'), 'LateSunset': ('Sunset', 'Night')}
_SHORT_COPY = {'EarlySunrise': 'Sunrise', 'LateSunrise': 'Sunrise', 'EarlySunset': 'Sunset',
               'LateSunset': 'Sunset'}

# IMGS used for a NULL imagespace slot: Fallout4.esm [00000167] "DefaultImageSpace" (the record and its
# Editor ID are verified; that the engine falls back to it is the prior art's claim, unverified).
DEFAULT_IMAGESPACE_FID = 0x00000167

# Encodings of the values sample() returns; included in every sample so the renderer never has to guess.
SAMPLE_UNITS = {
    'colors': 'stored byte / 255 (0-1), NOT linearised: sRGB-ish authoring values blended linearly in '
              'that space; the renderer applies any ^2.2 / sRGB decode and HDR scaling',
    'dalc': 'same as colors; Scale is the raw DALC float',
    'imagespace': 'raw IMGS values blended by time-of-day weight; nothing pre-multiplied (Sunlight Scale, '
                  'Sky Scale etc. are left for the renderer); tint colour is the stored 0-1 float',
    'god_rays': 'raw GDRY values (colours are the stored 0-1 floats)',
    'fog': 'game units (64 units = 1 yard, about 1.43 cm per unit) for near/far/height; power, max and '
           'high_density_scale unitless; day/night pairs blended by day_factor',
    'cloud_layers': 'color as colors; alpha raw JNAM float; speed as FO4Edit shows it ((byte-127)/1270)',
    'wind': 'speed = byte / 255; direction_deg inferred as byte * 360 / 256',
}

# FO4Edit's short labels, as printed in its one-line colour summaries (ESR:RGB(...) SR:RGB(...) ...).
TOD_SHORT = {'EarlySunrise': 'ESR', 'Sunrise': 'SR', 'LateSunrise': 'LSR', 'Day': 'D',
             'EarlySunset': 'ESS', 'Sunset': 'SS', 'LateSunset': 'LSS', 'Night': 'N'}

# NAM0 colour slots in storage order, with FO4Edit's names. Slot 2 is "Unknown" in FO4Edit; the CK labels
# it "Cloud Layer" (string table in CreationKit.exe) and every vanilla weather leaves it black.
NAM0_SLOTS = ('Sky-Upper', 'Fog Near', 'Unknown', 'Ambient', 'Sunlight', 'Sun', 'Stars', 'Sky-Lower',
              'Horizon', 'Effect Lighting', 'Cloud LOD Diffuse', 'Cloud LOD Ambient', 'Fog Far',
              'Sky Statics', 'Water Multiplier', 'Sun Glare', 'Moon Glare', 'Fog Near High', 'Fog Far High')
NAM0_CK_LABELS = dict(zip(NAM0_SLOTS, NAM0_SLOTS), Unknown='Cloud Layer')

# DALC: six directional ambient colours, an ambient specular colour, then a float (FO4Edit: "Scale").
DALC_DIRECTIONS = ('X+', 'X-', 'Y+', 'Y-', 'Z+', 'Z-')

# FNAM fog floats. The first eight exist in every FO4 weather; the height-fog ten were added later and are
# optional in FO4Edit's definition.
FOG_FIELDS = ('Day - Near', 'Day - Far', 'Night - Near', 'Night - Far', 'Day - Power', 'Night - Power',
              'Day - Max', 'Night - Max', 'Day - Near Height Mid', 'Day - Near Height Range',
              'Night - Near Height Mid', 'Night - Near Height Range', 'Day - High Density Scale',
              'Night - High Density Scale', 'Day - Far Height Mid', 'Day - Far Height Range',
              'Night - Far Height Mid', 'Night - Far Height Range')

WEATHER_FLAGS = ('Weather - Pleasant', 'Weather - Cloudy', 'Weather - Rainy', 'Weather - Snow',
                 'Sky Statics - Always Visible', 'Sky Statics - Follows Sun Position', 'Rain Occlusion',
                 'HUD Rain Effects')

SOUND_TYPES = ('Default', 'Precipitation', 'Wind', 'Thunder')

# IMGS HNAM (HDR), CNAM (cinematic) and the legacy ENAM block that predates them.
IMGS_HDR_FIELDS = ('Eye Adapt Speed', 'Tonemap E', 'Bloom Threshold', 'Bloom Scale', 'Auto Exposure Max',
                   'Auto Exposure Min', 'Sunlight Scale', 'Sky Scale', 'Middle Gray')
IMGS_CINEMATIC_FIELDS = ('Saturation', 'Brightness', 'Contrast')
IMGS_ENAM_HDR_FIELDS = ('Eye Adapt Speed', 'Tonemap E', 'Bloom Threshold', 'Bloom Scale',
                        'Auto Exposure Min/Max', 'Sunlight Scale', 'Sky Scale')

GDRY_FIELDS = (('Back Color', 3), ('Fwd Color', 3), ('Intensity', 1), ('Air Color - Scale', 1),
               ('Back Color - Scale', 1), ('Fwd Color - Scale', 1), ('Back Phase', 1), ('Air Color', 3),
               ('Fwd Phase', 1))

SPGD_FIELDS = (('Gravity Velocity', 'f'), ('Rotation Velocity', 'f'), ('Particle Size X', 'f'),
               ('Particle Size Y', 'f'), ('Center Offset Min', 'f'), ('Center Offset Max', 'f'),
               ('Initial Rotation', 'f'), ('# of Subtextures X', 'I'), ('# of Subtextures Y', 'I'),
               ('Type', 'I'), ('Box Size', 'I'), ('Particle Density', 'f'))

# Curated vanilla Commonwealth weathers for the viewer, picked after reading the records. The Commonwealth
# worldspace uses DefaultClimate [0000015F], whose list holds eight weathers; seven are here (the
# rain-and-mist CommonwealthMistyRainy is left out as a near-duplicate of Rain). The eighth preset,
# CommonwealthGSOvercast, is the Glowing Sea's haze, listed by the AudioExtGlowingSeaOuter region.
# CommonwealthDusty, CommonwealthPolluted and the CommonwealthDarkSkies variants exist but no vanilla
# climate or region lists them, so they are not offered. presets() resolves these against the records.
PRESET_EDIDS = (
    ('CommonwealthClear', 'Clear', 'The most common Commonwealth weather.'),
    ('CommonwealthClearestSkies', 'Clearest skies', 'Cloudless, high-visibility variant of Clear.'),
    ('CommonwealthOvercast', 'Overcast', 'Cloud cover, flat light.'),
    ('CommonwealthMisty', 'Misty', 'Low haze and soft light.'),
    ('CommonwealthFoggy', 'Foggy', 'Dense near fog.'),
    ('CommonwealthRain', 'Rain', 'Rain precipitation; wets surfaces.'),
    ('CommonwealthGSRadstorm', 'Radstorm', 'Green radiation storm with lightning.'),
    ('CommonwealthGSOvercast', 'Glowing Sea haze', 'Yellow-green overcast of the Glowing Sea.'),
)

_COMPRESSED = 0x00040000
_DELETED = 0x00000020
_ESM = 0x00000001
_ESL = 0x00000200

# Record types read in full, and types only indexed by Editor ID so references can be named.
_FULL_TYPES = (b'WTHR', b'CLMT', b'IMGS', b'GDRY', b'SPGD', b'RFCT', b'REGN', b'WRLD')
_NAME_TYPES = (b'LENS', b'SNDR', b'GLOB', b'SPEL', b'ARTO', b'EFSH')


# --------------------------------------------------------------------------------------------------------
# Low-level plugin reading
# --------------------------------------------------------------------------------------------------------

def _cstr(b):
    """Zero-terminated cp1252 string (non-localized strings in FO4 plugins)."""
    i = b.find(b'\0')
    if i >= 0:
        b = b[:i]
    return b.decode('cp1252', errors='replace')


_SUB_U16 = struct.Struct('<H').unpack_from
_SUB_U32 = struct.Struct('<I').unpack_from
_SUB_SIGS = {}                     # signature bytes -> its latin-1 text (decoded once; a cell open walks ~100,000)


def _subrecords(body):
    """Yield (signature, payload) pairs, honouring XXXX size overrides."""
    pos, end, big = 0, len(body), None
    while pos + 6 <= end:
        sig = body[pos:pos + 4]
        size = _SUB_U16(body, pos + 4)[0]
        pos += 6
        if sig == b'XXXX':
            big = _SUB_U32(body, pos)[0]
            pos += size
            continue
        if big is not None:
            size, big = big, None
        k = _SUB_SIGS.get(sig)
        if k is None:
            k = sig.decode('latin1')
            if len(_SUB_SIGS) < 4096:          # (bounded: a damaged record could make up signatures)
                _SUB_SIGS[sig] = k
        yield k, body[pos:pos + size]
        pos += size


class _Record:
    __slots__ = ('sig', 'fid', 'flags', 'plugin', 'subs', 'edid')

    def __init__(self, sig, fid, flags, plugin, subs):
        self.sig, self.fid, self.flags, self.plugin, self.subs = sig, fid, flags, plugin, subs
        self.edid = next((_cstr(v) for k, v in subs if k == 'EDID'), '')

    def first(self, sig):
        return next((v for k, v in self.subs if k == sig), None)

    def all(self, sig):
        return [v for k, v in self.subs if k == sig]


class _Plugin:
    """One plugin file: header, master list and the load-order mapping of its FormIDs.

    The file is memory-mapped only while it is scanned from end to end (map() ... unmap()); after that, records are
    read by position with handles that never stop the Creation Kit, FO4Edit or a script from saving the plugin
    (fileshare.py). A plugin saved after it was read raises fileshare.Stale on the next read."""

    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
        self.data = None
        with open_shared(path) as f:
            self.stamp = fstamp(f)
            head = f.read(24)
            if len(head) < 24 or head[:4] != b'TES4':
                raise ValueError('%s: not a TES4 plugin' % path)
            size, flags = struct.unpack_from('<II', head, 4)
            hdr = f.read(size)
        self.file = SharedFile(path, self.stamp)
        self.flags = flags
        self.header_end = 24 + size
        self.masters = [_cstr(v) for k, v in _subrecords(hdr) if k == 'MAST']
        self.is_light = bool(flags & _ESL)
        self.prefix_map = []      # FormID high byte -> callable(low bits) -> load-order FormID or None
        self.self_map = None

    def map(self):
        """The whole file, memory-mapped, for a full scan; unmap() right after (a mapped file cannot be saved)."""
        if self.data is None:
            with open_shared(self.path) as f:
                if fstamp(f) != self.stamp:
                    raise Stale('%s changed on disk' % self.name)
                self.data = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        return self.data

    def unmap(self):
        d, self.data = self.data, None
        if d is not None:
            d.close()

    def read(self, pos, n):
        """n bytes at pos: from the mapping during a scan, else a positioned read."""
        if self.data is not None:
            return self.data[pos:pos + n]
        return self.file.read(pos, n)

    def close(self):
        self.unmap()
        self.file.close()

    def global_fid(self, raw):
        """Translate a FormID as stored in this file to the load-order FormID (None if unresolvable)."""
        if raw == 0:
            return 0
        idx = raw >> 24
        if idx < len(self.prefix_map):
            m = self.prefix_map[idx]
            return m(raw) if m else None
        return self.self_map(raw)

    def iter_top_groups(self):
        d = self.map()
        pos, end = self.header_end, len(d)
        while pos + 24 <= end:
            sig, gsize, label, gtype = struct.unpack_from('<4sI4si', d, pos)
            if sig != b'GRUP':
                raise ValueError('%s: expected GRUP at 0x%X' % (self.name, pos))
            yield label, pos, gsize
            pos += gsize

    def iter_records(self, start, end, sigs):
        """Records of the wanted signatures between start and end; nested GRUPs are skipped entirely
        (for WRLD that skips every cell, which this module never needs)."""
        d, pos = self.map(), start
        while pos + 24 <= end:
            sig, size, flags, fid = struct.unpack_from('<4sIII', d, pos)
            if sig == b'GRUP':
                pos += size
                continue
            body_start = pos + 24
            pos = body_start + size
            if sig not in sigs:
                continue
            body = d[body_start:body_start + size]
            if flags & _COMPRESSED:
                body = zlib.decompress(body[4:])
            yield sig.decode('latin1'), fid, flags, body


# --------------------------------------------------------------------------------------------------------
# Field helpers
# --------------------------------------------------------------------------------------------------------

def _rgb(b, off=0):
    return [b[off], b[off + 1], b[off + 2]]


def _floats(b, n=None):
    n = len(b) // 4 if n is None else n
    return list(struct.unpack_from('<%df' % n, b, 0))


def _r(x, nd=6):
    """Round floats for JSON output (keeps the stored float32 values readable)."""
    return round(x, nd) if isinstance(x, float) else x


def _hex(fid):
    return None if fid is None else '%08X' % fid


def _clmt_time(byte):
    """CLMT TNAM times are stored in units of 10 minutes (FO4Edit shows e.g. 30 as 5:00:00 AM)."""
    return byte / 6.0


def _cloud_speed(byte):
    """RNAM/QNAM cloud layer speed byte -> FO4Edit's displayed value ((b - 127) / 1270)."""
    return (byte - 127) / 1270.0


def _hhmm(hour):
    minutes = int(round((hour % 24.0) * 60.0)) % 1440
    return '%02d:%02d' % divmod(minutes, 60)


def _lerp(a, b, t):
    return a + (b - a) * t


# --------------------------------------------------------------------------------------------------------
# The database
# --------------------------------------------------------------------------------------------------------

class WeatherDB:
    """Weather, climate, imagespace and god-ray records from a Fallout 4 load order.

    data_dir: the game's Data folder. masters: plugin file names in load order; files that do not exist
    are skipped (so the DLC masters are optional). Later files override earlier ones, as in the game.
    FormIDs are reported in full load-order form (high byte = index among the files actually loaded;
    a light plugin uses FE + 12-bit index), as hex strings such as '0002B52A'.
    """

    def __init__(self, data_dir, masters=DEFAULT_MASTERS):
        self.data_dir = data_dir
        self.plugins = []
        for name in masters:
            path = os.path.join(data_dir, name)
            if exists(path):
                self.plugins.append(_Plugin(path))
        if not self.plugins:
            raise FileNotFoundError('none of %s found in %s' % (', '.join(masters), data_dir))
        self._assign_load_order()
        self.records = {}            # load-order FormID -> _Record (winning override)
        self.origin = {}             # load-order FormID -> plugin that first defined it
        self.names = {}              # load-order FormID -> (signature, EditorID) for referenced types
        self.by_edid = {}            # (signature, lower EditorID) -> load-order FormID
        self._imgs_cache = {}
        try:
            for p in self.plugins:
                self._load_plugin(p)
                p.unmap()            # parsed: release the file before mapping the next one
        finally:
            for p in self.plugins:   # all parsing is done (or failed); nothing keeps the files open
                p.close()

    # ---- loading --------------------------------------------------------------------------------------

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

    def _load_plugin(self, p):
        wanted_full, wanted_names = set(_FULL_TYPES), set(_NAME_TYPES)
        for label, gpos, gsize in p.iter_top_groups():
            if label not in wanted_full and label not in wanted_names:
                continue
            for sig, raw_fid, flags, body in p.iter_records(gpos + 24, gpos + gsize, {label}):
                fid = p.global_fid(raw_fid)
                if fid is None:
                    continue
                if flags & _DELETED:
                    self.records.pop(fid, None)
                    continue
                subs = list(_subrecords(body))
                rec = _Record(sig, fid, flags, p, subs)
                if label in wanted_full:
                    self.records[fid] = rec
                self.origin.setdefault(fid, p.name)
                self.names[fid] = (sig, rec.edid)
                if rec.edid:
                    self.by_edid[(sig, rec.edid.lower())] = fid

    # ---- lookups --------------------------------------------------------------------------------------

    def _resolve(self, key, sig):
        """FormID from an int, a hex string ('0002B52A' / '0x2B52A') or an Editor ID."""
        if isinstance(key, int):
            return key if key in self.records and self.records[key].sig == sig else None
        s = str(key).strip()
        fid = self.by_edid.get((sig, s.lower()))
        if fid is not None:
            return fid
        try:
            v = int(s[2:] if s.lower().startswith('0x') else s, 16)
        except ValueError:
            return None
        rec = self.records.get(v)
        return v if rec is not None and rec.sig == sig else None

    def _record(self, key, sig):
        fid = self._resolve(key, sig)
        if fid is None:
            raise KeyError('%s %r not found' % (sig, key))
        return self.records[fid]

    def _ref(self, p, raw):
        """A FormID stored in plugin p -> {'formid', 'edid', 'type'} (None for a NULL reference)."""
        fid = p.global_fid(raw)
        if fid == 0:
            return None
        if fid is None:
            return {'formid': None, 'edid': None, 'type': None, 'unresolved': '%08X' % raw}
        sig, edid = self.names.get(fid, (None, None))
        return {'formid': _hex(fid), 'edid': edid, 'type': sig}

    def _ident(self, rec):
        return {'formid': _hex(rec.fid), 'edid': rec.edid, 'plugin': rec.plugin.name,
                'origin': self.origin.get(rec.fid)}

    # ---- listings -------------------------------------------------------------------------------------

    def list_weathers(self):
        """Every weather: [{formid, edid, plugin (winning file), origin (defining file)}], sorted by EDID."""
        out = [dict(self._ident(r)) for r in self.records.values() if r.sig == 'WTHR']
        return sorted(out, key=lambda d: d['edid'].lower())

    def list_climates(self):
        out = [dict(self._ident(r)) for r in self.records.values() if r.sig == 'CLMT']
        return sorted(out, key=lambda d: d['edid'].lower())

    def list_worldspaces(self):
        """Worldspaces with their climate: [{formid, edid, plugin, climate, parent}]."""
        out = []
        for r in self.records.values():
            if r.sig != 'WRLD':
                continue
            c = r.first('CNAM')
            w = r.first('WNAM')
            out.append(dict(self._ident(r),
                            climate=self._ref(r.plugin, struct.unpack('<I', c)[0]) if c else None,
                            parent=self._ref(r.plugin, struct.unpack('<I', w)[0]) if w else None))
        return sorted(out, key=lambda d: d['edid'].lower())

    def region_weathers(self, worldspace=None):
        """Regions that carry a weather list (REGN RDAT type 3 + RDWT), optionally for one worldspace."""
        wfid = None
        if worldspace is not None:
            wfid = self._resolve(worldspace, 'WRLD')
        out = []
        for r in self.records.values():
            if r.sig != 'REGN':
                continue
            w = r.first('WNAM')
            wref = self._ref(r.plugin, struct.unpack('<I', w)[0]) if w else None
            if wfid is not None and (wref is None or wref['formid'] != _hex(wfid)):
                continue
            entries, in_weather, priority, override = [], False, None, None
            for k, v in r.subs:
                if k == 'RDAT':
                    # RDAT header: u32 type (3 = Weather), u8 flags (bit 0 Override), u8 priority.
                    in_weather = struct.unpack_from('<I', v, 0)[0] == 3
                    if in_weather:
                        override = bool(v[4] & 1) if len(v) > 4 else None
                        priority = v[5] if len(v) > 5 else None
                elif k == 'RDWT' and in_weather:
                    for i in range(0, len(v) - 11, 12):
                        wf, chance, gl = struct.unpack_from('<IiI', v, i)
                        entries.append({'weather': self._ref(r.plugin, wf), 'chance': chance,
                                        'global': self._ref(r.plugin, gl)})
            if entries:
                out.append(dict(self._ident(r), worldspace=wref, priority=priority, override=override,
                                weathers=entries))
        return sorted(out, key=lambda d: d['edid'].lower())

    # ---- WTHR -----------------------------------------------------------------------------------------

    def get_weather(self, key, include_imagespaces=True):
        """Decode one weather. Keys inside the colour/DALC/fog/DATA blocks are FO4Edit's field names;
        colours are [r, g, b] 0-255 as stored. With include_imagespaces the IMSP imagespaces and WGDR
        god rays are decoded inline."""
        rec = self._record(key, 'WTHR')
        p = rec.plugin
        w = self._ident(rec)
        w['cloud_layers'] = []
        textures, speeds_y, speeds_x, ccolors, calphas = {}, None, None, None, None
        dalc = []
        unparsed = []
        for k, v in rec.subs:
            if k == 'EDID':
                continue
            if len(k) == 4 and k[1:] == '0TX' and 0 <= ord(k[0]) - 0x30 < 32:
                textures[ord(k[0]) - 0x30] = _cstr(v)          # '00TX'..'90TX', ':0TX'..'O0TX'
            elif k == 'LNAM':
                w['LNAM - Unknown'] = struct.unpack('<I', v)[0] if len(v) == 4 else v.hex()
            elif k == 'MNAM':
                w['precipitation_type'] = self._ref(p, struct.unpack('<I', v)[0])
            elif k == 'NNAM':
                w['visual_effect'] = self._ref(p, struct.unpack('<I', v)[0])
            elif k == 'ONAM':
                w['ONAM - Unused'] = v.hex()
            elif k == 'RNAM':
                speeds_y = [_cloud_speed(b) for b in v]
            elif k == 'QNAM':
                speeds_x = [_cloud_speed(b) for b in v]
            elif k == 'PNAM':
                ccolors = v
            elif k == 'JNAM':
                calphas = v
            elif k == 'NAM0':
                w['colors'] = self._decode_nam0(v)
            elif k == 'NAM4':
                w['NAM4 - Unknown'] = [_r(x) for x in _floats(v)]
            elif k == 'FNAM':
                fl = _floats(v)
                w['fog'] = {FOG_FIELDS[i]: _r(x) for i, x in enumerate(fl[:len(FOG_FIELDS)])}
            elif k == 'DATA':
                w['data'] = self._decode_wthr_data(v)
            elif k == 'NAM1':
                mask = struct.unpack('<I', v)[0]
                w['disabled_cloud_layers'] = [i for i in range(32) if mask >> i & 1]
            elif k == 'SNAM':
                fid, typ = struct.unpack_from('<II', v)
                w.setdefault('sounds', []).append(
                    {'sound': self._ref(p, fid), 'type': SOUND_TYPES[typ] if typ < 4 else typ})
            elif k == 'TNAM':
                w.setdefault('sky_statics', []).append(self._ref(p, struct.unpack('<I', v)[0]))
            elif k == 'IMSP':
                w['imagespaces'] = self._tod_refs(p, v)
            elif k == 'WGDR':
                w['god_rays'] = self._tod_refs(p, v)
            elif k == 'DALC':
                dalc.append(self._decode_dalc(v))
            elif k == 'MODL':
                w['aurora_model'] = _cstr(v)
            elif k in ('MODT', 'MODC', 'MODS', 'MODF'):
                pass                                            # model metadata of the aurora; not lighting
            elif k == 'GNAM':
                w['sun_glare_lens_flare'] = self._ref(p, struct.unpack('<I', v)[0])
            elif k == 'UNAM':
                w['magic'] = self._decode_unam(p, v)
            elif k == 'VNAM':
                w['volatility_mult'] = _r(struct.unpack('<f', v)[0])
            elif k == 'WNAM':
                w['visibility_mult'] = _r(struct.unpack('<f', v)[0])
            else:
                unparsed.append(k)
        if dalc:
            # Eight DALC subrecords, one per time of day in storage order (FO4Edit: DALC - Sunrise ...).
            w['dalc'] = {TOD_STORAGE[i]: d for i, d in enumerate(dalc[:8])}
        # Cloud layers that have a texture. PNAM / JNAM hold 32 layers x 8 (or 4, old records) times of day.
        disabled = set(w.get('disabled_cloud_layers', ()))
        for i in sorted(textures):
            layer = {'layer': i, 'texture': textures[i], 'enabled': i not in disabled}
            if speeds_y is not None and i < len(speeds_y):
                layer['speed_y'] = _r(speeds_y[i])
            if speeds_x is not None and i < len(speeds_x):
                layer['speed_x'] = _r(speeds_x[i])
            if ccolors is not None:
                stride = len(ccolors) // 32
                layer['colors'] = {TOD_STORAGE[t]: _rgb(ccolors, i * stride + t * 4) for t in range(stride // 4)}
            if calphas is not None:
                stride = len(calphas) // 32
                vals = struct.unpack_from('<%df' % (stride // 4), calphas, i * stride)
                layer['alphas'] = {TOD_STORAGE[t]: _r(x) for t, x in enumerate(vals)}
            w['cloud_layers'].append(layer)
        flags = w.get('data', {}).get('Flags', [])
        w['classification'] = {
            'pleasant': 'Weather - Pleasant' in flags, 'cloudy': 'Weather - Cloudy' in flags,
            'rainy': 'Weather - Rainy' in flags, 'snow': 'Weather - Snow' in flags}
        w['wetness'] = self._wetness_info(w)
        if include_imagespaces:
            for slot, ref in (w.get('imagespaces') or {}).items():
                if ref and ref.get('formid'):
                    ref['record'] = self.get_imagespace(ref['formid'])
            for slot, ref in (w.get('god_rays') or {}).items():
                if ref and ref.get('formid'):
                    ref['record'] = self.get_god_rays(ref['formid'])
        if unparsed:
            w['unparsed_subrecords'] = unparsed
        return w

    def _decode_nam0(self, v):
        # 19 (or 17, without the two high-fog slots) colour slots x 8 times of day x RGBA; old records
        # (four vanilla weathers) store 17 slots x 4 times of day. FO4Edit decodes them the same way.
        ntod = 8 if len(v) % 32 == 0 and len(v) // 32 >= 17 else 4
        nslots = len(v) // (ntod * 4)
        out = {}
        for s in range(min(nslots, len(NAM0_SLOTS))):
            base = s * ntod * 4
            out[NAM0_SLOTS[s]] = {TOD_STORAGE[t]: _rgb(v, base + t * 4) for t in range(ntod)}
        return out

    @staticmethod
    def _decode_dalc(v):
        d = {name: _rgb(v, i * 4) for i, name in enumerate(DALC_DIRECTIONS)}
        d['Specular'] = _rgb(v, 24)
        if len(v) >= 32:
            d['Scale'] = _r(struct.unpack_from('<f', v, 28)[0])
        return d

    @staticmethod
    def _decode_wthr_data(v):
        flags = v[11]
        d = {
            'Wind Speed': v[0],
            'Unknown': v[1:3].hex(' '),
            'Trans Delta': v[3],
            'Sun Glare': v[4],
            'Sun Damage': v[5],
            'Precipitation - Begin Fade In': v[6],
            'Precipitation - End Fade Out': v[7],
            'Thunder/Lightning - Begin Fade In': v[8],
            'Thunder/Lightning - End Fade Out': v[9],
            'Thunder/Lightning - Frequency': v[10],
            'Flags': [WEATHER_FLAGS[i] for i in range(8) if flags >> i & 1],
            'Lightning Color': _rgb(v, 12),
            'Visual Effect - Begin': v[15],
            'Visual Effect - End': v[16],
            'Wind Direction': v[17],
            'Wind Direction Range': v[18],
        }
        if len(v) > 19:
            d['Wind Turbulance'] = v[19]                       # FO4Edit's spelling
        return d

    def _tod_refs(self, p, v):
        n = len(v) // 4
        # FO4Edit 4.1.5f labels the eighth IMSP entry "EarlySunrise" (a naming slip in its definition);
        # by position it is LateSunset, and the vanilla data agree (e.g. CW_ClearDUSK_L).
        return {TOD_STORAGE[i]: self._ref(p, struct.unpack_from('<I', v, i * 4)[0]) for i in range(min(n, 8))}

    def _decode_unam(self, p, v):
        d = {'On Lightning Strike - Spell': self._ref(p, struct.unpack_from('<I', v, 0)[0]),
             'On Lightning Strike - Threshold': _r(struct.unpack_from('<f', v, 4)[0])}
        if len(v) >= 12:
            d['On Weather Activate - Spell'] = self._ref(p, struct.unpack_from('<I', v, 8)[0])
        if len(v) >= 16:
            d['On Weather Activate - Threshold'] = _r(struct.unpack_from('<f', v, 12)[0])
        return d

    def _wetness_info(self, w):
        """What the record says about rain and wet surfaces (see docs/weather-notes.md, section 9)."""
        prec = w.get('precipitation_type')
        ptype = None
        if prec and prec.get('formid'):
            sp = self.get_precipitation(prec['formid'])
            ptype = sp.get('data', {}).get('Type') if sp else None
        flags = w.get('data', {}).get('Flags', [])
        data = w.get('data', {})
        return {
            'precipitation_type': ptype,
            'rainy_flag': 'Weather - Rainy' in flags,
            'rain_occlusion': 'Rain Occlusion' in flags,
            'hud_rain_effects': 'HUD Rain Effects' in flags,
            'precip_begin_fade_in': _r(data.get('Precipitation - Begin Fade In', 0) / 255.0, 4),
            'precip_end_fade_out': _r(data.get('Precipitation - End Fade Out', 0) / 255.0, 4),
            # Inferred: the engine raises its world wetness level while rain precipitation falls.
            'makes_surfaces_wet': ptype == 'Rain',
        }

    # ---- IMGS / GDRY / SPGD / RFCT --------------------------------------------------------------------

    def get_imagespace(self, key):
        """Decode an IMGS record: HDR, cinematic, tint, depth of field and LUT (FO4Edit field names)."""
        rec = self._record(key, 'IMGS')
        if rec.fid in self._imgs_cache:
            return copy.deepcopy(self._imgs_cache[rec.fid])
        out = self._ident(rec)
        for k, v in rec.subs:
            if k == 'ENAM':                                     # legacy block (older form versions)
                f = _floats(v)
                out['enam_legacy'] = {
                    'HDR': {n: _r(f[i]) for i, n in enumerate(IMGS_ENAM_HDR_FIELDS) if i < len(f)},
                    'Cinematic': {n: _r(f[7 + i]) for i, n in enumerate(IMGS_CINEMATIC_FIELDS) if 7 + i < len(f)},
                    'Tint': {'Amount': _r(f[10]) if len(f) > 10 else None,
                             'Color': [_r(x) for x in f[11:14]]}}
            elif k == 'HNAM':
                f = _floats(v)
                out['hdr'] = {n: _r(f[i]) for i, n in enumerate(IMGS_HDR_FIELDS) if i < len(f)}
            elif k == 'CNAM':
                f = _floats(v)
                out['cinematic'] = {n: _r(f[i]) for i, n in enumerate(IMGS_CINEMATIC_FIELDS) if i < len(f)}
            elif k == 'TNAM':
                f = _floats(v)
                # Colour stored as 0-1 floats; FO4Edit displays it as RGB(round(x*255)).
                out['tint'] = {'Amount': _r(f[0]), 'Color': [_r(x) for x in f[1:4]]}
            elif k == 'DNAM':
                out['depth_of_field'] = self._decode_dof(v)
            elif k == 'TX00':
                out['lut'] = _cstr(v)
        self._imgs_cache[rec.fid] = out
        return copy.deepcopy(out)

    @staticmethod
    def _decode_dof(v):
        d = {}
        n = len(v)
        if n >= 4:
            d['Strength'] = _r(struct.unpack_from('<f', v, 0)[0])
        if n >= 8:
            d['Distance'] = _r(struct.unpack_from('<f', v, 4)[0])
        if n >= 12:
            d['Range'] = _r(struct.unpack_from('<f', v, 8)[0])
        if n >= 16:
            # FO4Edit splits bytes 12-15 into 2 unused bytes and a u16 enum "Sky / Blur Radius". Read as one
            # float (the low half is zero in every vanilla record) the value is 2 + 8 * radius, plus 4 for
            # "No Sky": 2, 10 .. 58 = Radius 0-7 and 6, 14 .. 62 = No Sky, Radius 0-7. The rule reproduces
            # FO4Edit's label for every vanilla IMGS (docs/weather-notes.md).
            raw = struct.unpack_from('<H', v, 14)[0]
            fv = struct.unpack_from('<f', v, 12)[0]
            d['Sky / Blur Radius'] = WeatherDB._sky_blur_label(raw, fv)
            d['sky_blur_radius_raw'] = raw
            d['blur_radius'], d['no_sky'] = WeatherDB._sky_blur_decode(fv)
        if n >= 20:
            d['Vignette Radius'] = _r(struct.unpack_from('<f', v, 16)[0])
        if n >= 24:
            d['Vignette Strength'] = _r(struct.unpack_from('<f', v, 20)[0])
        return d

    @staticmethod
    def _sky_blur_decode(fv):
        r = (fv - 2.0) / 8.0
        if fv >= 2.0 and abs(r - round(r)) < 1e-6 and round(r) <= 7:
            return int(round(r)), False
        r = (fv - 6.0) / 8.0
        if fv >= 6.0 and abs(r - round(r)) < 1e-6 and round(r) <= 7:
            return int(round(r)), True
        return None, None

    @staticmethod
    def _sky_blur_label(raw, fv):
        radius, no_sky = WeatherDB._sky_blur_decode(fv)
        if radius is None:
            return str(raw)
        return ('No Sky, Radius %d' if no_sky else 'Radius %d') % radius

    def get_god_rays(self, key):
        """Decode a GDRY record (colours are 0-1 floats as stored)."""
        rec = self._record(key, 'GDRY')
        out = self._ident(rec)
        v = rec.first('DATA')
        if v:
            f = _floats(v)
            pos, data = 0, {}
            for name, n in GDRY_FIELDS:
                if pos + n > len(f):
                    break
                data[name] = [_r(x) for x in f[pos:pos + n]] if n > 1 else _r(f[pos])
                pos += n
            out['data'] = data
        return out

    def get_precipitation(self, key):
        """Decode an SPGD (shader particle geometry: rain or snow) record."""
        try:
            rec = self._record(key, 'SPGD')
        except KeyError:
            return None
        out = self._ident(rec)
        v = rec.first('DATA')
        if v:
            data = {}
            for i, (name, fmt) in enumerate(SPGD_FIELDS):
                if i * 8 + 4 > len(v):                          # each value is followed by 4 unused bytes
                    break
                val = struct.unpack_from('<' + fmt, v, i * 8)[0]
                if name == 'Type':
                    val = ('Rain', 'Snow')[val] if val < 2 else val
                data[name] = _r(val)
            out['data'] = data
        tex = rec.first('MNAM')
        if tex is not None:
            out['particle_texture'] = _cstr(tex)
        return out

    def get_visual_effect(self, key):
        """Decode an RFCT record (the art object / effect shader a weather attaches to the camera)."""
        rec = self._record(key, 'RFCT')
        out = self._ident(rec)
        v = rec.first('DATA')
        if v and len(v) >= 12:
            art, shader, flags = struct.unpack_from('<III', v)
            out['data'] = {'Effect Art': self._ref(rec.plugin, art), 'Shader': self._ref(rec.plugin, shader),
                           'Flags': [n for i, n in enumerate(('Rotate to Face Target', 'Attach to Camera',
                                                              'Inherit Rotation')) if flags >> i & 1]}
        return out

    # ---- CLMT -----------------------------------------------------------------------------------------

    def get_climate(self, key):
        """Decode a climate: sunrise/sunset begin/end (game hours), weather list with chances, sun and
        glare textures, stars model, volatility and moon phase data."""
        rec = self._record(key, 'CLMT')
        p = rec.plugin
        out = self._ident(rec)
        for k, v in rec.subs:
            if k == 'WLST':
                out['weathers'] = []
                for i in range(0, len(v) - 7, 12 if len(v) % 12 == 0 else 8):
                    wf, chance = struct.unpack_from('<Ii', v, i)
                    gl = struct.unpack_from('<I', v, i + 8)[0] if len(v) % 12 == 0 else 0
                    out['weathers'].append({'weather': self._ref(p, wf), 'chance': chance,
                                            'global': self._ref(p, gl)})
            elif k == 'FNAM':
                out['sun_texture'] = _cstr(v)
            elif k == 'GNAM':
                out['sun_glare_texture'] = _cstr(v)
            elif k == 'MODL':
                out['stars_model'] = _cstr(v)
            elif k == 'TNAM' and len(v) >= 6:
                srb, sre, ssb, sse, vol, moons = v[:6]
                out['timing'] = {
                    'sunrise_begin': _r(_clmt_time(srb)), 'sunrise_end': _r(_clmt_time(sre)),
                    'sunset_begin': _r(_clmt_time(ssb)), 'sunset_end': _r(_clmt_time(sse)),
                    'raw': [srb, sre, ssb, sse],
                    'volatility': vol,
                    # FO4Edit reuses Skyrim's labels: bit 6 "Masser", bit 7 "Secunda", low 6 bits = phase
                    # length in days. FO4 renders one moon.
                    'moons': {'masser': bool(moons & 0x40), 'secunda': bool(moons & 0x80),
                              'phase_length_days': moons & 0x3F, 'raw': moons}}
        return out

    def climate_for_worldspace(self, key='Commonwealth'):
        """Load-order FormID (int) of a worldspace's climate (WRLD CNAM), or None if it has none."""
        rec = self._record(key, 'WRLD')
        c = rec.first('CNAM')
        if not c:
            return None
        fid = rec.plugin.global_fid(struct.unpack('<I', c)[0])
        return fid or None

    def _climate(self, climate):
        """A decoded climate from a key or a decoded dict; None = the Commonwealth worldspace's climate
        (DefaultClimate in vanilla)."""
        if isinstance(climate, dict):
            return climate
        if climate is None:
            try:
                climate = self.climate_for_worldspace('Commonwealth')
            except KeyError:
                climate = None
            if climate is None:
                climate = 'DefaultClimate'
        return self.get_climate(climate)

    def _timing(self, climate):
        """Sunrise/sunset hours for a climate (key, decoded climate, a bare timing dict, or None)."""
        if isinstance(climate, dict) and 'sunrise_begin' in climate:
            return climate
        return self._climate(climate)['timing']

    # ---- time of day ------------------------------------------------------------------------------------

    @staticmethod
    def tod_keys(timing):
        """Key times (game hours) at which each time-of-day colour set is at full strength.

        Calibrated scheme (docs/weather-notes.md §11, TOD_WINDOW_FRACTIONS): the climate's sunrise window
        [begin, end] runs EarlySunrise -> Sunrise -> LateSunrise -> Day in equal thirds, with the Night ->
        EarlySunrise ramp one third before it; the sunset window mirrors it (Day -> EarlySunset -> Sunset ->
        LateSunset, then the ramp to Night one third after). Day holds between the windows and Night outside
        the ramps; colours blend linearly between neighbouring keys.
        """
        srb, sre = timing['sunrise_begin'], timing['sunrise_end']
        ssb, sse = timing['sunset_begin'], timing['sunset_end']
        sre = max(sre, srb)
        ssb = max(ssb, sre)
        sse = max(sse, ssb)
        sunset_f = tuple(1.0 - f for f in reversed(TOD_WINDOW_FRACTIONS))
        keys = []
        for (b, e), names, fr in (((srb, sre), ('Night', 'EarlySunrise', 'Sunrise', 'LateSunrise', 'Day'),
                                   TOD_WINDOW_FRACTIONS),
                                  ((ssb, sse), ('Day', 'EarlySunset', 'Sunset', 'LateSunset', 'Night'), sunset_f)):
            keys += [(b + (e - b) * f, n) for f, n in zip(fr, names)]
        return keys

    def time_of_day_weights(self, climate, hour):
        """Which time-of-day sets blend at `hour` (0-24, fractional) and with what weights.

        Returns {'hour', 'weights': {slot: weight} (only non-zero, summing to 1), 'keys': [...],
        'day_factor'}. day_factor (0 night .. 1 day) ramps linearly across the sunrise and sunset windows;
        it is used for the FNAM day/night fog pairs. Both are inferred, not verified against the engine.
        """
        timing = self._timing(climate)
        keys = self.tod_keys(timing)
        h = hour % 24.0
        weights = {}
        if h <= keys[0][0] or h >= keys[-1][0]:
            weights['Night'] = 1.0
        else:
            for (t0, s0), (t1, s1) in zip(keys, keys[1:]):
                if t0 <= h <= t1:
                    if t1 - t0 < 1e-9 or s0 == s1:
                        weights[s0] = 1.0
                    else:
                        f = (h - t0) / (t1 - t0)
                        weights[s0] = weights.get(s0, 0.0) + (1.0 - f)
                        weights[s1] = weights.get(s1, 0.0) + f
                    break
        weights = {k: round(v, 6) for k, v in weights.items() if v > 1e-6}
        srb, sre = timing['sunrise_begin'], timing['sunrise_end']
        ssb, sse = timing['sunset_begin'], timing['sunset_end']
        if h <= srb or h >= sse:
            day = 0.0
        elif h < sre:
            day = (h - srb) / max(sre - srb, 1e-9)
        elif h <= ssb:
            day = 1.0
        else:
            day = 1.0 - (h - ssb) / max(sse - ssb, 1e-9)
        return {'hour': _r(h, 4), 'weights': weights, 'day_factor': _r(day, 4),
                'keys': [{'hour': _r(t, 4), 'time': _hhmm(t), 'tod': s} for t, s in keys],
                'timing': {k: timing[k] for k in ('sunrise_begin', 'sunrise_end', 'sunset_begin', 'sunset_end')}}

    # ---- sampling -----------------------------------------------------------------------------------------

    def sample(self, weather, hour, climate=None):
        """Interpolated lighting for `weather` at game hour `hour` (0-24, fractional).

        climate: a CLMT key or decoded climate; None uses the Commonwealth worldspace's climate.
        Nothing is linearised or pre-multiplied: colours are the stored 0-255 bytes divided by 255
        (sRGB-ish authoring values, blended linearly in that space) and imagespace / god-ray numbers are
        the raw record values blended with the time-of-day weights. The renderer decides linearisation and
        any scaling (e.g. by the imagespace Sunlight Scale). See the 'units' entry of the result.

        Records that store only the four Skyrim-era times of day (four vanilla weathers with old form
        versions, e.g. DefaultWeather) and NULL imagespace slots are filled the way the FO4_Base_Library
        prior art reads them (UNVERIFIED against the engine): a missing early/late colour is the per-byte
        average (a + b) >> 1 of its two neighbours (EarlySunrise = Night+Sunrise, LateSunrise =
        Sunrise+Day, EarlySunset = Day+Sunset, LateSunset = Sunset+Night); a missing early/late imagespace
        or god-ray slot copies Sunrise or Sunset; a NULL imagespace uses DefaultImageSpace [00000167].
        """
        w = weather if isinstance(weather, dict) and 'colors' in weather else self.get_weather(weather)
        climate = self._climate(climate)
        tw = self.time_of_day_weights(climate, hour)
        weights = tw['weights']

        def blend_rgb(per_tod):
            per_tod = _fill_tod(per_tod, colour=True)
            acc, total = [0.0, 0.0, 0.0], 0.0
            for slot, wt in weights.items():
                c = per_tod.get(slot)
                if c is None:
                    continue
                total += wt
                for i in range(3):
                    acc[i] += wt * c[i]
            return [_r(x / (255.0 * total), 5) for x in acc] if total else None

        def blend_num(per_tod):
            per_tod = _fill_tod(per_tod, colour=False)
            acc, total = 0.0, 0.0
            for slot, wt in weights.items():
                v = per_tod.get(slot)
                if v is None:
                    continue
                acc += wt * v
                total += wt
            return _r(acc / total, 6) if total else None

        out = {
            'weather': {'formid': w['formid'], 'edid': w['edid'], 'plugin': w['plugin']},
            'climate': {'formid': climate['formid'], 'edid': climate['edid']},
            'hour': tw['hour'], 'time': _hhmm(tw['hour']),
            'tod_weights': weights, 'tod_keys': tw['keys'], 'day_factor': tw['day_factor'],
            'timing': tw['timing'], 'units': SAMPLE_UNITS,
        }
        out['colors'] = {slot: blend_rgb(per) for slot, per in w.get('colors', {}).items()}

        dalc = w.get('dalc') or {}
        if dalc:
            out['dalc'] = {}
            for name in DALC_DIRECTIONS + ('Specular',):
                out['dalc'][name] = blend_rgb({t: d.get(name) for t, d in dalc.items()})
            out['dalc']['Scale'] = blend_num({t: d.get('Scale') for t, d in dalc.items()})

        fog = w.get('fog') or {}
        d = tw['day_factor']
        if fog:
            f = {}
            for key in ('Near', 'Far', 'Power', 'Max', 'Near Height Mid', 'Near Height Range',
                        'High Density Scale', 'Far Height Mid', 'Far Height Range'):
                dv, nv = fog.get('Day - ' + key), fog.get('Night - ' + key)
                if dv is None or nv is None:
                    continue
                f[key.lower().replace(' ', '_')] = _r(_lerp(nv, dv, d), 4)
            out['fog'] = f

        out['imagespace'] = self._blend_imagespaces(w, weights)
        out['god_rays'] = self._blend_god_rays(w, weights)

        layers = []
        for layer in w.get('cloud_layers', []):
            if not layer.get('enabled'):
                continue
            item = {'layer': layer['layer'], 'texture': layer['texture'],
                    'speed_x': layer.get('speed_x'), 'speed_y': layer.get('speed_y')}
            if 'colors' in layer:
                item['color'] = blend_rgb(layer['colors'])
            if 'alphas' in layer:
                item['alpha'] = blend_num(layer['alphas'])
            layers.append(item)
        out['cloud_layers'] = layers

        data = w.get('data', {})
        out['sun'] = {'glare': _r(data.get('Sun Glare', 0) / 255.0, 4),
                      'damage': _r(data.get('Sun Damage', 0) / 255.0, 4),
                      'sun_texture': climate.get('sun_texture'),
                      'glare_texture': climate.get('sun_glare_texture'),
                      'lens_flare': w.get('sun_glare_lens_flare')}
        out['wind'] = {'speed': _r(data.get('Wind Speed', 0) / 255.0, 4),
                       'direction_raw': data.get('Wind Direction'),
                       # Inferred: the byte maps 0-255 to 0-360 degrees, as the CK's 0-360 field suggests.
                       'direction_deg': _r(data.get('Wind Direction', 0) * 360.0 / 256.0, 2),
                       'direction_range_raw': data.get('Wind Direction Range'),
                       'turbulence_raw': data.get('Wind Turbulance')}
        out['classification'] = w.get('classification')
        out['precipitation'] = w.get('precipitation_type')
        out['visual_effect'] = w.get('visual_effect')
        out['wetness'] = w.get('wetness')
        out['lightning_color'] = [_r(c / 255.0, 5) for c in data.get('Lightning Color', [0, 0, 0])]
        return out

    def _tod_records(self, w, key, weights, getter, null_fallback=None):
        """Resolve the IMSP / WGDR record used for each weighted time of day, with the short-record and
        NULL rules described in sample(). Returns {slot: (decoded record, note or None)}."""
        refs = dict(w.get(key) or {})
        notes = {}
        for slot, src in _SHORT_COPY.items():
            if slot not in refs and src in refs:
                refs[slot] = refs[src]
                notes[slot] = 'missing slot, copied from ' + src
        out = {}
        for slot in weights:
            ref = refs.get(slot)
            if ref and ref.get('formid'):
                out[slot] = (ref.get('record') or getter(ref['formid']), notes.get(slot))
            elif null_fallback is not None:
                out[slot] = (null_fallback, 'NULL slot, engine default %s used' % null_fallback['edid'])
        return out

    def _default_imagespace(self):
        rec = self.records.get(DEFAULT_IMAGESPACE_FID)
        return self.get_imagespace(DEFAULT_IMAGESPACE_FID) if rec is not None and rec.sig == 'IMGS' else None

    def _blend_imagespaces(self, w, weights):
        recs = self._tod_records(w, 'imagespaces', weights, self.get_imagespace, self._default_imagespace())
        total = sum(weights[s] for s in recs)
        if not total:
            return None
        out = {'sources': []}
        for s, (rec, note) in recs.items():
            src = {'tod': s, 'weight': _r(weights[s] / total, 6), 'formid': rec['formid'], 'edid': rec['edid']}
            if note:
                src['note'] = note
            out['sources'].append(src)
        for block in ('hdr', 'cinematic', 'depth_of_field'):
            acc = {}
            for s, (rec, _) in recs.items():
                for k, v in (rec.get(block) or {}).items():
                    if isinstance(v, (int, float)) and not isinstance(v, bool) and k != 'sky_blur_radius_raw':
                        acc.setdefault(k, [0.0, 0.0])
                        acc[k][0] += weights[s] * v
                        acc[k][1] += weights[s]
            if acc:
                out[block] = {k: _r(a / t, 6) for k, (a, t) in acc.items()}
        # The sky flag of the depth of field cannot be blended: take it from the strongest source.
        main = max(recs, key=lambda s: weights[s])
        if 'depth_of_field' in out:
            out['depth_of_field']['no_sky'] = (recs[main][0].get('depth_of_field') or {}).get('no_sky')
        tint_amt, tint_col, tw = 0.0, [0.0, 0.0, 0.0], 0.0
        for s, (rec, _) in recs.items():
            t = rec.get('tint')
            if not t:
                continue
            tint_amt += weights[s] * t['Amount']
            for i in range(3):
                tint_col[i] += weights[s] * t['Color'][i]
            tw += weights[s]
        if tw:
            out['tint'] = {'amount': _r(tint_amt / tw, 6), 'color': [_r(c / tw, 6) for c in tint_col]}
        luts = {}
        for s, (rec, _) in recs.items():
            if rec.get('lut'):
                luts[rec['lut']] = luts.get(rec['lut'], 0.0) + weights[s] / total
        out['luts'] = [{'path': k, 'weight': _r(v, 6)} for k, v in sorted(luts.items(), key=lambda kv: -kv[1])]
        return out

    def _blend_god_rays(self, w, weights):
        recs = self._tod_records(w, 'god_rays', weights, self.get_god_rays)
        total = sum(weights[s] for s in recs)
        if not total:
            return None
        out = {'sources': [{'tod': s, 'weight': _r(weights[s] / total, 6), 'formid': rec['formid'],
                            'edid': rec['edid']} for s, (rec, _) in recs.items()]}
        for name, n in GDRY_FIELDS:
            acc = [0.0] * n
            for s, (rec, _) in recs.items():
                v = rec.get('data', {}).get(name)
                if v is None:
                    continue
                vals = v if n > 1 else [v]
                for i in range(n):
                    acc[i] += weights[s] * vals[i] / total
            key = name.lower().replace(' - ', '_').replace(' ', '_')
            out[key] = [_r(x, 6) for x in acc] if n > 1 else _r(acc[0], 6)
        return out

    # ---- presets ----------------------------------------------------------------------------------------

    def presets(self):
        """The curated viewer presets (PRESET_EDIDS) resolved against the loaded records.

        Each entry: edid, formid, plugin, label, note, 'climate' (the climate whose sunrise/sunset timing
        applies: the one listing the weather, else the climate of the worldspace whose region lists it),
        'listed_in' (every climate/region list naming the weather, with its chance), classification flags
        and precipitation. Weathers missing from the load order are left out.
        """
        climates = [self.get_climate(c['formid']) for c in self.list_climates()]
        regions = self.region_weathers()
        try:
            cw = _hex(self.climate_for_worldspace('Commonwealth'))
        except KeyError:
            cw = None
        out = []
        for edid, label, note in PRESET_EDIDS:
            fid = self._resolve(edid, 'WTHR')
            if fid is None:
                continue
            rec = self.records[fid]
            listed = []
            for c in sorted(climates, key=lambda c: (c['formid'] != cw, c['edid'])):
                for e in c.get('weathers', []):
                    if e['weather'] and e['weather']['formid'] == _hex(fid):
                        listed.append({'type': 'CLMT', 'formid': c['formid'], 'edid': c['edid'],
                                       'chance': e['chance']})
            for r in regions:
                for e in r['weathers']:
                    if e['weather'] and e['weather']['formid'] == _hex(fid):
                        listed.append({'type': 'REGN', 'formid': r['formid'], 'edid': r['edid'],
                                       'chance': e['chance'],
                                       'worldspace': (r['worldspace'] or {}).get('edid')})
            climate = next(({'formid': l['formid'], 'edid': l['edid']} for l in listed if l['type'] == 'CLMT'),
                           None)
            if climate is None:
                for l in listed:
                    if l['type'] == 'REGN' and l.get('worldspace'):
                        cf = self.climate_for_worldspace(l['worldspace'])
                        if cf is not None:
                            climate = {'formid': _hex(cf), 'edid': self.records[cf].edid}
                            break
            w = self.get_weather(fid, include_imagespaces=False)
            out.append({'edid': rec.edid, 'formid': _hex(fid), 'plugin': rec.plugin.name, 'label': label,
                        'note': note, 'climate': climate, 'listed_in': listed,
                        'classification': w['classification'],
                        'precipitation': (w.get('precipitation_type') or {}).get('edid')})
        return out


def _fill_tod(per_tod, colour):
    """Complete a per-time-of-day dict that holds only the four Skyrim-era entries (see sample())."""
    if not per_tod or all(per_tod.get(t) is not None for t in TOD_STORAGE):
        return per_tod
    out = dict(per_tod)
    for slot, (a, b) in _SHORT_AVERAGE.items():
        if out.get(slot) is None and per_tod.get(a) is not None and per_tod.get(b) is not None:
            if colour:
                out[slot] = [(x + y) >> 1 for x, y in zip(per_tod[a], per_tod[b])]
            else:
                out[slot] = (per_tod[a] + per_tod[b]) / 2.0
    return out


# --------------------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------------------

def _main(argv=None):
    import argparse
    import json
    import time
    ap = argparse.ArgumentParser(description='Print FO4 Lightbox weather presets and one weather sample.')
    ap.add_argument('--data', default=os.environ.get('FO4_DATA'),
                    help='Fallout 4 Data folder (or set FO4_DATA)')
    ap.add_argument('--weather', default='CommonwealthClear', help='weather Editor ID or FormID')
    ap.add_argument('--hour', type=float, default=12.0, help='game hour, 0-24')
    ap.add_argument('--climate', default=None, help='climate Editor ID or FormID (default: Commonwealth)')
    ap.add_argument('--record', action='store_true', help='dump the decoded weather record instead')
    ap.add_argument('--list', action='store_true', help='list every weather and exit')
    args = ap.parse_args(argv)
    if not args.data:
        ap.error('pass --data <Fallout 4 Data folder> or set FO4_DATA')
    t0 = time.time()
    db = WeatherDB(args.data)
    print('loaded %s in %.2f s' % (', '.join(p.name for p in db.plugins), time.time() - t0), file=sys.stderr)
    if args.list:
        for w in db.list_weathers():
            print('%s  %-50s %s' % (w['formid'], w['edid'], w['plugin']))
        return 0
    print('Presets:', file=sys.stderr)
    for p in db.presets():
        c = p['climate']
        lists = ', '.join('%s %d%%' % (l['edid'], l['chance']) for l in p['listed_in'][:3])
        print('  %-17s %s %-26s climate %-15s listed in: %s' % (
            p['label'], p['formid'], p['edid'], c['edid'] if c else '-', lists or '-'), file=sys.stderr)
    if args.record:
        print(json.dumps(db.get_weather(args.weather), indent=1))
    else:
        print(json.dumps(db.sample(args.weather, args.hour, args.climate), indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(_main())
