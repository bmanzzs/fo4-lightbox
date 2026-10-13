"""Build the FO4 Lightbox release zips.

    python tools/build_release.py [--out DIR] [--no-runtime] [--keep-stage] [--extract-to DIR]

1. Runs tools/check_clean.py on the project (it must pass).
2. Copies the files that ship (INCLUDE) to DIR/stage/FO4 Lightbox/. Anything else in the project is listed as not
   packaged, so a new file is never dropped (or shipped) silently.
3. Builds runtime/ from the Python running this script (Windows, 64-bit): python.exe and its DLLs (signed by the
   Python Software Foundation), and only the modules the viewer can import (runtime_modules: every import statement
   in the shipped scripts, followed through the standard library and numpy), each as one compiled .pyc in a plain
   Lib / site-packages folder, with the extension modules (.pyd) and DLLs those need; a python3XX._pth that keeps it
   apart from any other Python on the PC, the licences, and BINARIES.txt: every executable file with its SHA-256,
   its digital signature and where it comes from (numpy's checked against the hashes in its own RECORD). No
   archives inside the archive. Start Lightbox.bat and FO4 Lightbox.exe use runtime/ when it is there.
4. Checks the staged copy (check_clean, no nested archives, the runtime in a clean environment: every module it
   holds imports, every numpy name the viewer uses resolves, server --help) and writes FO4_Lightbox_<version>.zip
   (with runtime), FO4_Lightbox_<version>_without_Python.zip and SHA256SUMS.txt. Each zip holds the FO4 Lightbox
   folder and a fomod folder: a mod manager (Vortex, MO2) installs the viewer to Data\\Tools\\FO4 Lightbox, someone
   unpacking by hand just gets the folder.

DIR defaults to a folder next to the project: <project>_Release. Nothing is written inside the project.
"""
import argparse
import ast
import base64
import hashlib
import importlib.util
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile
from fnmatch import fnmatch
from py_compile import PycInvalidationMode, compile as compile_pyc

# compiled caches that do not depend on file times (the zip format keeps times to 2 s only)
UNCHECKED = PycInvalidationMode.UNCHECKED_HASH

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = 'FO4 Lightbox'                                     # the folder inside the zips
INCLUDE = ['Start Lightbox.bat', 'README.md', 'LICENSE',
           'server/*.py', 'server/vendor/*.py', 'server/vendor/README.md',
           'web/index.html', 'web/js/*.js', 'web/icon.png', 'web/about.jpg',
           'web/vendor/rapier/rapier.mjs', 'web/vendor/rapier/LICENSE', 'web/vendor/rapier/README.md',
           'launcher/Launcher.cs', 'launcher/app.manifest', 'launcher/lightbox.ico', 'launcher/make_icon.py',
           'launcher/make_splash.py', 'launcher/splash/splash.html',
           'docs/DEVELOPMENT.md', 'docs/engine-notes.md', 'docs/weather-notes.md',
           'scenes/*.esp',
           'tools/capture.py', 'tools/check_clean.py', 'tools/build_simple_cell.py', 'tools/build_release.py',
           'tools/cloth_check.py', 'tools/collision_check.py', 'tools/credits.py']
# kept out on purpose: research notes about other people's tools, Bman's calibration setup and restart script,
# caches, the remembered game folder
EXCLUDE = ['.claude/*', '*/__pycache__/*', '*.pyc', 'docs/prior-art.md', 'tools/calibration/*',
           'tools/restart_lightbox.ps1', 'game_path.txt',
           'launcher/splash.png']           # rendered from launcher/splash/splash.html by make_splash.py; inside the exe

# The runtime holds only the modules the viewer can import (runtime_modules), starting from these shipped scripts
RUNTIME_ROOTS = ['server/*.py', 'server/vendor/*.py', 'tools/capture.py', 'tools/cloth_check.py', 'tools/collision_check.py',
                 'tools/build_simple_cell.py', 'tools/check_clean.py', 'tools/credits.py']
# what no import statement shows: the codecs the viewer names in strings and Python's own defaults, and numpy's
# subpackages that the viewer reaches as attributes (np.random)
RUNTIME_EXTRA = ['encodings.' + c for c in (
    'aliases', 'ascii', 'charmap', 'cp1252', 'cp437', 'idna', 'latin_1', 'mbcs', 'oem', 'punycode',
    'raw_unicode_escape', 'unicode_escape', 'utf_16', 'utf_16_be', 'utf_16_le', 'utf_32', 'utf_32_be', 'utf_32_le',
    'utf_7', 'utf_8', 'utf_8_sig')] + ['numpy', 'numpy.random']
# imported only for what the viewer never does (HTTPS, .bz2 / .xz / .zst archives, OpenSSL hashes; hashlib falls back
# to the hashes built into Python): left out, with their DLLs
RUNTIME_DROP = {'ssl', '_ssl', 'bz2', '_bz2', 'lzma', '_lzma', 'compression.zstd', '_zstd', '_hashlib',
                '_pyrepl', 'pydoc'}                      # (the interactive console and help(), from site.py)
# numpy modules whose imports inside functions are numpy's lazy attributes (np.fft, np.ma, np.f2py ...) and test
# hooks: only their module-level imports count
NUMPY_LAZY = {'numpy', 'numpy._pytesttester'}
# DLLs an extension module needs next to it (prefixes of names in Python's DLLs folder)
DLL_DEPS = {'_ctypes': ('libffi-',), '_ssl': ('libssl-', 'libcrypto-'), '_hashlib': ('libcrypto-',),
            '_sqlite3': ('sqlite3',)}
# a file that is itself an archive (mod sites quarantine archives inside archives)
ARCHIVE_EXT = ('.zip', '.whl', '.7z', '.rar', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.cab', '.egg')
ARCHIVE_MAGIC = (b'PK\x03\x04', b'7z\xbc\xaf\x27\x1c', b'Rar!', b'\x1f\x8b', b'MSCF')


def rel(p, base):
    return os.path.relpath(p, base).replace('\\', '/')


def project_files():
    out = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d != '.git']
        out += [rel(os.path.join(dp, f), ROOT) for f in fn]
    return sorted(out)


def app_version():
    m = re.search(r"^VERSION = '([^']+)'", open(os.path.join(ROOT, 'server', 'app.py'), encoding='utf-8').read(), re.M)
    return m.group(1)


def stage_app(dst):
    files = project_files()
    take = [f for f in files if any(fnmatch(f, p) for p in INCLUDE) and not any(fnmatch(f, p) for p in EXCLUDE)]
    left = [f for f in files if f not in take and not any(fnmatch(f, p) for p in EXCLUDE)]
    for f in take:
        os.makedirs(os.path.dirname(os.path.join(dst, f)), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, f), os.path.join(dst, f))
    for p in INCLUDE:
        if not any(fnmatch(f, p) for f in take):
            sys.exit(f'nothing matches {p!r}: the include list is out of date')
    return take, left


def _imports(path, modname, is_pkg, top_only=False):
    """Every module an import statement in a Python file names (relative imports resolved), and for `from pkg import
    name` also pkg.name, in case it is a submodule. Skipped: `if __name__ == '__main__':` blocks (self-tests: heapq's
    alone would pull in doctest, pdb, asyncio and multiprocessing) and `if TYPE_CHECKING:` blocks; with top_only,
    also everything inside functions and classes."""
    try:
        tree = ast.parse(open(path, 'rb').read(), path)
    except (SyntaxError, ValueError):
        return set()
    pkg = modname if is_pkg else modname.rpartition('.')[0]
    out = set()

    def skip(n):
        if isinstance(n, ast.If):
            t = n.test
            if isinstance(t, ast.Compare) and isinstance(t.left, ast.Name) and t.left.id == '__name__':
                return True
            if (isinstance(t, ast.Name) and t.id == 'TYPE_CHECKING') or \
                    (isinstance(t, ast.Attribute) and t.attr == 'TYPE_CHECKING'):
                return True
        return top_only and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda))

    def walk(n):
        for c in ast.iter_child_nodes(n):
            if not skip(c):
                yield c
                yield from walk(c)
    for node in walk(tree):
        if isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = pkg.split('.') if pkg else []
                base = base[:len(base) - (node.level - 1)]
                mod = '.'.join(base + ([node.module] if node.module else []))
            else:
                mod = node.module
            if mod:
                out.add(mod)
                out.update(mod + '.' + a.name for a in node.names if a.name != '*')
    return out


def runtime_modules():
    """(standard library modules, their extension modules, numpy modules) that the shipped scripts can import: every
    import statement in RUNTIME_ROOTS followed through the standard library and numpy (imports inside functions too:
    a rarely used code path still finds its module), plus Python's start-up modules and RUNTIME_EXTRA, minus
    RUNTIME_DROP. Read from the Python running this build, the one the runtime is copied from."""
    import numpy
    lib = os.path.normcase(os.path.join(sys.base_prefix, 'Lib'))
    dlls = os.path.normcase(os.path.join(sys.base_prefix, 'DLLs'))
    npd = os.path.normcase(os.path.dirname(numpy.__file__))
    local = [os.path.join(ROOT, 'server'), os.path.join(ROOT, 'server', 'vendor'), os.path.join(ROOT, 'tools')]
    # what Python loads at start-up and what importing numpy loads (its compiled core imports Python modules from C
    # code, which no import statement shows)
    r = subprocess.run([sys.executable, '-I', '-X', 'utf8', '-c',
                        'import sys, numpy, numpy.random; print("\\n".join(sys.modules))'],
                       capture_output=True, text=True, check=True)
    todo = r.stdout.split() + RUNTIME_EXTRA
    roots = [f for p in RUNTIME_ROOTS for f in project_files() if fnmatch(f, p)]
    for f in roots:
        todo += _imports(os.path.join(ROOT, f), '', False)
    std, ext, npm, seen = set(), set(), set(), set()
    saved_path = sys.path[:]
    sys.path[:0] = local
    try:
        while True:
            _follow(todo, seen, std, ext, npm, lib, dlls, npd)
            # then import all of them here and keep what that loads too: compiled modules import Python modules from
            # C code (_ctypes needs ctypes._layout), which no import statement shows. Until nothing new turns up.
            code = ('import importlib, sys\nfor m in sys.argv[1:]:\n    try:\n        importlib.import_module(m)\n'
                    '    except Exception:\n        pass\nprint("\\n".join(sys.modules))')
            r = subprocess.run([sys.executable, '-I', '-X', 'utf8', '-c', code] + sorted(std | npm),
                               capture_output=True, text=True, check=True)
            todo = [m for m in r.stdout.split() if m not in seen]
            if not todo:
                break
    finally:
        sys.path[:] = saved_path
    return std, ext, npm


def _follow(todo, seen, std, ext, npm, lib, dlls, npd):
    """runtime_modules' search: each module name in todo (and its parent packages), sorted into std / ext / npm by
    where it lives, and the imports of its source followed."""
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        if any(name == d or name.startswith(d + '.') for d in RUNTIME_DROP):
            continue
        parts = name.split('.')
        todo += ['.'.join(parts[:i]) for i in range(1, len(parts))]
        try:
            spec = importlib.util.find_spec(name)
        except (ImportError, AttributeError, ValueError):
            continue                                # not a module (a name inside one), or not on Windows
        if spec is None:
            continue
        origin = spec.origin or ''
        o = os.path.normcase(origin)
        is_pkg = spec.submodule_search_locations is not None
        if origin == 'frozen':                      # frozen into python3XX.dll; its source still ships
            src = os.path.join(sys.base_prefix, 'Lib', *parts, '__init__.py') if is_pkg else \
                os.path.join(sys.base_prefix, 'Lib', *parts) + '.py'
            if os.path.isfile(src):
                origin, o = src, os.path.normcase(src)
        if o.startswith(npd):
            npm.add(name)
            if o.endswith('.py'):
                todo += _imports(origin, name, is_pkg, top_only=name in NUMPY_LAZY)
        elif o.startswith(lib) and o.endswith('.py') and 'site-packages' not in o:
            std.add(name)
            todo += _imports(origin, name, is_pkg)
        elif o.startswith(dlls) and o.endswith('.pyd'):
            ext.add(name)
        elif o.endswith('.py') and os.path.normcase(ROOT) in o:
            todo += _imports(origin, name, is_pkg)  # the viewer's own modules


def _source_of(name, base):
    """(source file, is package) of a module under base (Lib or site-packages), or (None, is package) for a package
    folder without __init__.py."""
    parts = name.split('.')
    init = os.path.join(base, *parts, '__init__.py')
    if os.path.isfile(init):
        return init, True
    if os.path.isdir(os.path.join(base, *parts)):
        return None, True
    return os.path.join(base, *parts) + '.py', False


def _compile_to(src, dst, shown):
    """One module compiled to a lone .pyc where its .py would be (Python imports it without the source)."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    compile_pyc(src, cfile=dst, dfile=shown, doraise=True, invalidation_mode=UNCHECKED)


def build_runtime(dst, extra=()):
    if os.name != 'nt' or struct.calcsize('P') != 8:
        sys.exit('the runtime is built from a 64-bit Windows Python (run with --no-runtime elsewhere)')
    import numpy
    base = sys.base_prefix
    tag = f'{sys.version_info.major}{sys.version_info.minor}'
    std, ext, npm = runtime_modules()
    os.makedirs(dst)
    for f in ('python.exe', 'python3.dll', f'python{tag}.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
        shutil.copy2(os.path.join(base, f), dst)
    shutil.copy2(os.path.join(base, 'LICENSE.txt'), os.path.join(dst, 'LICENSE-python.txt'))
    dll_dir = os.path.join(base, 'DLLs')
    dll_names = sorted(os.listdir(dll_dir))
    for m in sorted(ext):                               # flat, like the embeddable package
        shutil.copy2(os.path.join(dll_dir, m + '.pyd'), dst)
        for prefix in DLL_DEPS.get(m, ()):
            for f in dll_names:
                if f.lower().startswith(prefix) and f.lower().endswith('.dll'):
                    shutil.copy2(os.path.join(dll_dir, f), dst)
    # the standard library modules, each one compiled .pyc in a plain Lib folder (no source, no __pycache__)
    lib, lib_dst = os.path.join(base, 'Lib'), os.path.join(dst, 'Lib')
    for m in sorted(std):
        src, is_pkg = _source_of(m, lib)
        parts = m.split('.')
        if src is None:
            os.makedirs(os.path.join(lib_dst, *parts), exist_ok=True)
            continue
        out = os.path.join(lib_dst, *parts, '__init__.pyc') if is_pkg else os.path.join(lib_dst, *parts) + '.pyc'
        _compile_to(src, out, os.path.join('Lib', os.path.relpath(src, lib)))
    # numpy the same way: its compiled modules (.pyd) as they are, the rest as .pyc; its DLLs and its dist-info
    # (licences, RECORD) whole
    np_dir = os.path.dirname(numpy.__file__)
    site = os.path.dirname(np_dir)
    sp = os.path.join(dst, 'site-packages')
    pyds = {}
    for dp, dn, fn in os.walk(np_dir):
        for f in fn:
            if f.endswith('.pyd'):
                mod = '.'.join(['numpy'] + [p for p in rel(dp, np_dir).split('/') if p not in ('', '.')] + [f.split('.')[0]])
                pyds[mod] = os.path.join(dp, f)
    for m in sorted(npm):
        if m in pyds:
            out = os.path.join(sp, os.path.relpath(pyds[m], site))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(pyds[m], out)
            continue
        src, is_pkg = _source_of(m, site)
        parts = m.split('.')
        if src is None:
            os.makedirs(os.path.join(sp, *parts), exist_ok=True)
            continue
        out = os.path.join(sp, *parts, '__init__.pyc') if is_pkg else os.path.join(sp, *parts) + '.pyc'
        _compile_to(src, out, os.path.join('site-packages', os.path.relpath(src, site)))
    for d in [d for d in os.listdir(site) if d == 'numpy.libs' or re.fullmatch(r'numpy-[\d.]+\.dist-info', d)]:
        shutil.copytree(os.path.join(site, d), os.path.join(sp, d))
    with open(os.path.join(dst, f'python{tag}._pth'), 'w', encoding='ascii', newline='\r\n') as f:
        f.write('Lib\n.\nsite-packages\n')
    pyver = '.'.join(map(str, sys.version_info[:3]))
    with open(os.path.join(dst, 'README.txt'), 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(f'''The Python that FO4 Lightbox runs on, so that nothing has to be installed.

Python {pyver} (64-bit) from https://www.python.org/ - licence: LICENSE-python.txt
numpy {numpy.__version__} from https://numpy.org/ - licences: site-packages/numpy-{numpy.__version__}.dist-info/licenses/

A trimmed copy: only the modules the viewer imports ({len(std)} of the standard library, {len(npm)} of numpy), each
one compiled .pyc in Lib or site-packages. tools\\build_release.py in the viewer's folder lists how they are picked.
python{tag}._pth keeps it apart from any other Python on this PC (no PYTHONPATH, no user site-packages).
BINARIES.txt lists every executable file here with its SHA-256, its digital signature and its source.
FO4 Lightbox.exe and Start Lightbox.bat use it. Delete this folder to run the viewer on your own Python 3.10+ with
numpy instead.
''')
    write_binaries(dst, pyver, numpy.__version__, site, extra)
    return pyver, numpy.__version__, (std, ext, npm)


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def write_binaries(dst, pyver, npver, site, extra=()):
    """BINARIES.txt: each .exe / .dll / .pyd with size, SHA-256, Authenticode signer and origin. numpy's files are
    compared with the SHA-256 list in numpy's own RECORD (written when the PyPI wheel was installed)."""
    files = sorted(os.path.join(dp, f) for dp, dn, fn in os.walk(dst) for f in fn
                   if f.lower().endswith(('.exe', '.dll', '.pyd')))
    ps = ("$r = foreach ($p in (Get-Content -LiteralPath $env:LB_LIST)) { $s = Get-AuthenticodeSignature -LiteralPath $p; "
          "[pscustomobject]@{p=[string]$p; status=[string]$s.Status; signer=$(if ($s.SignerCertificate) "
          "{ ($s.SignerCertificate.Subject -split ',')[0] -replace '^CN=','' } else { '' })} }; $r | ConvertTo-Json -Compress")
    lst = os.path.join(dst, '_binaries.lst')
    with open(lst, 'w', encoding='utf-8') as f:
        f.write('\n'.join(files))
    out = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], capture_output=True, text=True,
                         env=dict(os.environ, LB_LIST=lst))
    os.remove(lst)
    sig = {os.path.normcase(d['p']): d for d in json.loads(out.stdout or '[]')} if out.returncode == 0 else {}
    record = {}
    for dist in [d for d in os.listdir(site) if re.fullmatch(r'numpy-[\d.]+\.dist-info', d)]:
        for line in open(os.path.join(site, dist, 'RECORD'), encoding='utf-8'):
            parts = line.rstrip('\n').rsplit(',', 2)
            if len(parts) == 3 and parts[1].startswith('sha256='):
                b = base64.urlsafe_b64decode(parts[1][7:] + '=' * (-len(parts[1][7:]) % 4))
                record[parts[0].replace('\\', '/').lower()] = b.hex()
    files = list(extra) + files
    rows, bad = [], []
    for p in files:
        r = rel(p, dst)
        digest = sha256(p)
        s = sig.get(os.path.normcase(p), {})
        signed = f"signed: {s['signer']}" if s.get('status') == 'Valid' else 'not signed'
        if p in extra:
            r = '..\\' + os.path.basename(p)
            origin, check = ('the viewer\'s launcher, compiled from launcher\\Launcher.cs by tools\\build_release.py with '
                             'the .NET Framework 4 C# compiler that ships with Windows'), ''
        elif r.startswith('site-packages/'):
            want = record.get(r[len('site-packages/'):].lower())
            cp = f'cp{sys.version_info.major}{sys.version_info.minor}'
            origin = f'numpy {npver} wheel from PyPI (numpy-{npver}-{cp}-{cp}-win_amd64.whl)'
            check = 'matches numpy RECORD' if want == digest else 'DOES NOT MATCH numpy RECORD'
            if want != digest:
                bad.append(r)
        else:
            origin, check = f'Python {pyver} for Windows (64-bit), python.org', ''
        rows.append(f'{r}\n    {os.path.getsize(p):,} bytes  sha256 {digest}\n    {signed}; {origin}' + (f'; {check}' if check else ''))
    if bad:
        sys.exit('numpy files differ from their RECORD hashes: ' + ', '.join(bad))
    nsigned = sum('signed:' in x for x in rows)
    with open(os.path.join(dst, 'BINARIES.txt'), 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(f'''Every executable file (.exe / .dll / .pyd) in FO4 Lightbox: {len(rows)} files, {nsigned} digitally signed.

The viewer itself is the Python and JavaScript source in server\\ and web\\. Its only compiled file of its own is
..\\FO4 Lightbox.exe, a small launcher built from the source in launcher\\Launcher.cs (listed first, not signed).
The rest are the unmodified Python {pyver} runtime from python.org (signed by the Python Software Foundation;
vcruntime by Microsoft) and the numpy {npver} package from PyPI (its compiled modules are not signed by the numpy
project; each one matches the SHA-256 in numpy's own RECORD file, site-packages\\numpy-{npver}.dist-info\\RECORD).
Sources: https://github.com/python/cpython/tree/v{pyver} and https://github.com/numpy/numpy/tree/v{npver}
Built by tools\\build_release.py (see docs\\DEVELOPMENT.md, "Release package").

''' + '\n'.join(rows) + '\n')


def clean_env():
    """An environment with no Python anywhere on PATH, as on a PC that never had one."""
    keep = {k: v for k, v in os.environ.items() if not k.upper().startswith(('PYTHON', 'CONDA', 'VIRTUAL_ENV'))}
    sysroot = os.environ.get('SystemRoot', r'C:\Windows')
    keep['PATH'] = os.pathsep.join([os.path.join(sysroot, 'System32'), sysroot])
    return keep


def numpy_names():
    """The numpy attributes the viewer's code uses (np.<name>), as far as the numpy here has them."""
    import numpy
    names = set()
    for p in RUNTIME_ROOTS:
        for f in project_files():
            if fnmatch(f, p):
                names.update(re.findall(r'\bnp\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)',
                                        open(os.path.join(ROOT, f), encoding='utf-8').read()))
    out = set()
    for n in names:
        obj = numpy
        try:
            for part in n.split('.'):
                obj = getattr(obj, part)
            out.add(n)
        except AttributeError:
            head = n.split('.')[0]
            if hasattr(numpy, head):
                out.add(head)                           # np.x.<method of an array or a dtype>
    return sorted(out)


def check_runtime(stage, modules):
    """The staged runtime, in an environment without any other Python: every module it holds imports (those this
    build's own Python can import), every numpy name the viewer uses resolves, and the server starts (--help)."""
    std, ext, npm = modules
    py = os.path.join(stage, 'runtime', 'python.exe')
    want = []
    for m in sorted(std | ext | npm):
        r = subprocess.run([sys.executable, '-I', '-c', f'import {m}'], capture_output=True)
        if r.returncode == 0:
            want.append(m)                              # (some, like ctypes.macholib.dyld, are for other systems)
    probe = (f'import importlib, sys\nbad = []\nfor m in {want!r}:\n'
             f'    try:\n        importlib.import_module(m)\n    except Exception as e:\n'
             f'        bad.append(f"{{m}}: {{e!r}}")\n'
             f'import numpy\nfor n in {numpy_names()!r}:\n    o = numpy\n    try:\n'
             f'        for p in n.split("."):\n            o = getattr(o, p)\n    except Exception as e:\n'
             f'        bad.append(f"np.{{n}}: {{e!r}}")\n'
             f'print("\\n".join(bad) if bad else "OK", len({want!r}), sys.version.split()[0], numpy.__version__, '
             f'sys.flags.isolated)\n')
    r = subprocess.run([py, '-X', 'utf8', '-c', probe], env=clean_env(), cwd=stage, capture_output=True, text=True)
    if r.returncode or not r.stdout.startswith('OK'):
        sys.exit('bundled runtime failed:\n' + r.stdout + r.stderr)
    print('  runtime: every module imports, every numpy name resolves:', r.stdout.strip())
    r = subprocess.run([py, os.path.join('server', 'app.py'), '--help'], env=clean_env(), cwd=stage,
                       capture_output=True, text=True)
    if r.returncode or 'FO4 Lightbox' not in r.stdout:
        sys.exit('server/app.py --help failed on the bundled runtime:\n' + r.stdout + r.stderr)
    print('  server/app.py --help: OK')


def fomod(version):
    """fomod/info.xml and fomod/ModuleConfig.xml: Vortex and Mod Organizer 2 install the FO4 Lightbox folder to
    Data\\Tools\\FO4 Lightbox (as with BodySlide); the viewer writes nothing there (see server/app.py)."""
    info = f'''<?xml version="1.0" encoding="UTF-8"?>
<fomod>
  <Name>FO4 Lightbox (Nif Viewer)</Name>
  <Author>Bman</Author>
  <Version>{version}</Version>
  <Website>https://www.nexusmods.com/fallout4/mods/109801</Website>
  <Description>See a mesh the way Fallout 4 renders it, without loading the game. Installs to Data\\Tools\\FO4 Lightbox: run FO4 Lightbox.exe from there.</Description>
  <Groups>
    <element>Utilities</element>
  </Groups>
</fomod>
'''
    config = '''<?xml version="1.0" encoding="UTF-8"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">
  <moduleName>FO4 Lightbox</moduleName>
  <requiredInstallFiles>
    <folder source="FO4 Lightbox" destination="Tools\\FO4 Lightbox" />
  </requiredInstallFiles>
</config>
'''
    return {'fomod/info.xml': info, 'fomod/ModuleConfig.xml': config}


def write_zip(path, stage, skip_runtime, version):
    n = 0
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, text in fomod(version).items():
            z.writestr(name, text.replace('\n', '\r\n').encode('utf-8'))
        for dp, dn, fn in os.walk(stage):
            dn.sort()
            if skip_runtime and rel(dp, stage).split('/')[0] == 'runtime':
                continue
            for f in sorted(fn):
                p = os.path.join(dp, f)
                if skip_runtime and rel(p, stage) == LAUNCHER:
                    continue                                    # the file without Python has no executables
                parts = rel(p, stage).split('/')
                if '__pycache__' in parts[:-1] and parts[0] != 'runtime':
                    continue                                    # caches written by the checks above
                z.write(p, APP + '/' + rel(p, stage))
                n += 1
    return n


LAUNCHER = 'FO4 Lightbox.exe'


def find_csc():
    """The C# compiler that ships with Windows (.NET Framework 4.x)."""
    windir = os.environ.get('WINDIR', r'C:\Windows')
    for fw in ('Framework64', 'Framework'):
        p = os.path.join(windir, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe')
        if os.path.isfile(p):
            return p
    return None


def build_launcher(out_exe, version):
    """FO4 Lightbox.exe from launcher/Launcher.cs (see that file), with the version and the icon."""
    csc = find_csc()
    if not csc:
        sys.exit('no C# compiler (.NET Framework 4 csc.exe) on this PC: run with --no-launcher')
    src = os.path.join(ROOT, 'launcher')
    info = os.path.join(os.path.dirname(out_exe), '_AssemblyInfo.cs')
    v4 = '.'.join((version.split('.') + ['0', '0', '0'])[:4])
    with open(info, 'w', encoding='utf-8') as f:
        f.write('\n'.join(f'[assembly: System.Reflection.{k}("{v}")]' for k, v in (
            ('AssemblyTitle', 'FO4 Lightbox'), ('AssemblyProduct', 'FO4 Lightbox'),
            ('AssemblyDescription', 'FO4 Lightbox - Fallout 4 NIF viewer (launcher)'), ('AssemblyCompany', 'Bman'),
            ('AssemblyCopyright', 'GPL-3.0'), ('AssemblyVersion', v4), ('AssemblyFileVersion', v4),
            ('AssemblyInformationalVersion', version))) + '\n')
    try:
        r = subprocess.run([csc, '/nologo', '/codepage:65001', '/target:winexe', '/optimize+',
                            '/win32icon:' + os.path.join(src, 'lightbox.ico'),
                            '/win32manifest:' + os.path.join(src, 'app.manifest'),
                            '/resource:' + os.path.join(src, 'lightbox.ico') + ',lightbox.ico',
                            '/resource:' + os.path.join(src, 'splash.png') + ',splash.png',
                            '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/out:' + out_exe,
                            os.path.join(src, 'Launcher.cs'), info], capture_output=True, text=True)
    finally:
        os.remove(info)
    if r.returncode or not os.path.isfile(out_exe):
        sys.exit('building the launcher failed:\n' + r.stdout + r.stderr)
    return out_exe


def nested_archives(stage):
    """Files in the stage that are archives themselves, by name or by their first bytes."""
    bad = []
    for dp, dn, fn in os.walk(stage):
        for f in fn:
            p = os.path.join(dp, f)
            with open(p, 'rb') as fh:
                head = fh.read(8)
            if f.lower().endswith(ARCHIVE_EXT) or head.startswith(ARCHIVE_MAGIC):
                bad.append(rel(p, stage))
    return bad


def main():
    ap = argparse.ArgumentParser(description='Build the FO4 Lightbox release zips.')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(ROOT), os.path.basename(ROOT) + '_Release'))
    ap.add_argument('--no-runtime', action='store_true', help='only the zip without Python')
    ap.add_argument('--keep-stage', action='store_true', help='keep DIR/stage after zipping (for testing)')
    ap.add_argument('--no-launcher', action='store_true', help='leave out FO4 Lightbox.exe (no C# compiler here)')
    ap.add_argument('--extract-to', metavar='DIR', help='also unpack the zip with Python to DIR (DIR/FO4 Lightbox, '
                    'replacing the copy from the last build): a fixed folder for a shortcut to the newest build')
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    if os.path.commonpath([out, ROOT]) == ROOT:
        sys.exit('--out must be outside the project folder')
    ver = app_version()
    print(f'FO4 Lightbox {ver}')
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'check_clean.py')], capture_output=True, text=True)
    print('  project:', r.stdout.strip())
    if r.returncode:
        sys.exit(r.stdout + r.stderr)
    stage = os.path.join(out, 'stage', APP)
    if os.path.isdir(os.path.dirname(stage)):
        shutil.rmtree(os.path.dirname(stage))
    take, left = stage_app(stage)
    print(f'  {len(take)} files staged')
    for f in left:
        print('  not packaged (add it to INCLUDE or EXCLUDE):', f)
    extra = []
    if not a.no_runtime and not a.no_launcher:
        extra.append(build_launcher(os.path.join(stage, LAUNCHER), ver))
        print(f'  {LAUNCHER}: {os.path.getsize(extra[0]) / 1024:.0f} KiB')
    if not a.no_runtime:
        pyver, npver, mods = build_runtime(os.path.join(stage, 'runtime'), extra)
        nfiles = sum(len(fn) for _, _, fn in os.walk(os.path.join(stage, 'runtime')))
        print(f'  runtime: Python {pyver} ({len(mods[0])} stdlib modules, {len(mods[1])} extension modules), '
              f'numpy {npver} ({len(mods[2])} modules): {nfiles} files')
        check_runtime(stage, mods)
    r = subprocess.run([sys.executable, os.path.join(stage, 'tools', 'check_clean.py')], capture_output=True, text=True)
    print('  staged copy:', r.stdout.strip().splitlines()[0] if r.stdout.strip() else '')
    if r.returncode:
        sys.exit(r.stdout + r.stderr)
    nested = nested_archives(stage)
    if nested:
        sys.exit('archives inside the release (mod sites quarantine these): ' + ', '.join(nested))
    print('  no archives inside the release')
    zips = []
    if not a.no_runtime:
        zips.append((os.path.join(out, f'FO4_Lightbox_{ver}.zip'), False))
    zips.append((os.path.join(out, f'FO4_Lightbox_{ver}_without_Python.zip'), True))
    sums = []
    for path, skip in zips:
        n = write_zip(path, stage, skip, ver)
        sums.append(f'{sha256(path)}  {os.path.basename(path)}')
        print(f'  {os.path.basename(path)}: {n} files, {os.path.getsize(path) / 2 ** 20:.1f} MiB')
    with open(os.path.join(out, 'SHA256SUMS.txt'), 'w', encoding='ascii', newline='\n') as f:
        f.write('\n'.join(sums) + '\n')
    if not a.keep_stage:
        shutil.rmtree(os.path.dirname(stage))
    if a.extract_to:
        extract_build(zips[0][0], a.extract_to)
    print('done:', out)


def extract_build(zip_path, dest):
    """Unpack the newest build over DIR's copy of the last one (DIR/FO4 Lightbox), so one shortcut always starts the
    newest build. The old copy is first renamed aside: Windows refuses while any of its files is open, so a copy that
    is running is left as it is (no half-updated folder) and the build says so."""
    app = os.path.join(dest, 'FO4 Lightbox')
    if os.path.isdir(app):
        old = app + '.old'
        shutil.rmtree(old, ignore_errors=True)
        try:
            os.rename(app, old)
        except OSError:
            print(f'  NOT unpacked to {app}: that copy is running (close FO4 Lightbox, then build again)')
            return
        shutil.rmtree(old, ignore_errors=True)
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(dest, [n for n in z.namelist() if n.startswith('FO4 Lightbox/')])    # (not the fomod folder)
    print(f'  unpacked to {app}')


if __name__ == '__main__':
    main()
