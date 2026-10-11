"""Release guard: fail if anything Bethesda-owned (or derived from it as code) is inside the project folder.

    python tools/check_clean.py

Checks every file under the project for game data by extension (nif, dds, bgsm, bgem, ba2, esm, esp, esl, hkx, fxp,
swf, fuz, xwm, wav, pex) and by content (DXBC shader bytecode, DDS / NIF / BA2 / TES4 headers, D3D disassembly and
HLSL-style decompiler output). Exit code 1 lists the offenders. Run it before every publish.

The one exception: the viewer's own test scenes in scenes/ (built by tools/build_simple_cell.py), plugins that hold
only a cell and placed references (Fallout4.esm objects by FormID, no records or assets copied from the game).
"""
import os
import re
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'.git', '__pycache__', 'node_modules'}
BAD_EXT = {'.nif', '.dds', '.bgsm', '.bgem', '.ba2', '.esm', '.esp', '.esl', '.hkx', '.fxp', '.swf', '.fuz',
           '.xwm', '.wav', '.pex', '.psc', '.lip', '.btd', '.btr', '.bto', '.cso', '.dxbc'}
MAGIC = [(b'DXBC', 'compiled D3D shader'), (b'DDS ', 'DDS texture'), (b'Gamebryo File Format', 'NIF mesh'),
         (b'BTDX', 'BA2 archive'), (b'TES4', 'plugin file'), (b'BGSM', 'material file'), (b'BGEM', 'material file')]
# text that only shows up in shader disassembly / decompiler output
DISASM = re.compile(rb'(^|\n)\s*(dcl_(constantbuffer|resource|sampler|input|output|temps)|ps_5_0|vs_5_0|'
                    rb'sample_indexable|sample_l_indexable|mad r\d+\.|mul r\d+\.)|cb\d+\[\d+\]\.[xyzw]{1,4}')


def own_scene(path):
    """True for a scene plugin written by tools/build_simple_cell.py: TES4 + CELL + REFR records only."""
    try:
        d = open(path, 'rb').read()
        if d[:4] != b'TES4' or b'FO4 Lightbox test scene' not in d[:512]:
            return False
        pos = 0
        while pos + 24 <= len(d):
            sig, size = struct.unpack_from('<4sI', d, pos)
            if sig == b'GRUP':
                pos += 24                      # step into the group
                continue
            if sig not in (b'TES4', b'CELL', b'REFR'):
                return False
            pos += 24 + size
        return pos == len(d)
    except (OSError, struct.error):
        return False


def main():
    bad = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in fn:
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, ROOT)
            if rel.replace('\\', '/') == 'tools/check_clean.py':
                continue
            ext = os.path.splitext(f)[1].lower()
            if ext == '.esp' and os.path.dirname(rel) == 'scenes' and own_scene(p):
                continue
            if ext in BAD_EXT:
                bad.append((rel, f'game file type {ext}'))
                continue
            try:
                with open(p, 'rb') as fh:
                    data = fh.read(8 << 20)
            except OSError as e:
                bad.append((rel, f'unreadable: {e}'))
                continue
            for magic, what in MAGIC:
                if data.startswith(magic) or (magic == b'DXBC' and b'DXBC' in data and ext not in ('.md',)):
                    bad.append((rel, what))
                    break
            else:
                m = DISASM.search(data)
                if m:
                    bad.append((rel, f'looks like shader disassembly/decompiler output: {m.group(0)[:40]!r}'))
    if bad:
        print('NOT CLEAN - remove these before publishing:')
        for rel, why in bad:
            print(f'  {rel}: {why}')
        sys.exit(1)
    print(f'clean: no game files or shader code under {ROOT}')


if __name__ == '__main__':
    main()
