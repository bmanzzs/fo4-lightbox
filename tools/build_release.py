"""Build the FO4 Lightbox release zips.

    python tools/build_release.py [--out DIR] [--no-runtime] [--keep-stage] [--extract-to DIR]

1. Runs tools/check_clean.py on the project (it must pass).
2. Copies the files that ship (INCLUDE) to DIR/stage/FO4 Lightbox/. Anything else in the project is listed as not
   packaged, so a new file is never dropped (or shipped) silently.
3. Builds runtime/ from the Python running this script (Windows, 64-bit): python.exe and its DLLs (signed by the
   Python Software Foundation), the standard library as a plain Lib folder with its compiled caches (no tests,
   tkinter, IDLE, pip or venv), numpy from site-packages (no tests, test modules, headers or type stubs), a
   python3XX._pth that keeps it apart from any other Python on the PC, the licences, and BINARIES.txt: every
   executable file with its SHA-256, its digital signature and where it comes from (numpy's checked against the
   hashes in its own RECORD). No archives inside the archive. Start Lightbox.bat uses runtime/ when it is there.
4. Checks the staged copy (check_clean, no nested archives, the runtime in a clean environment: imports, server
   --help) and writes FO4_Lightbox_<version>.zip (with runtime), FO4_Lightbox_<version>_without_Python.zip and
   SHA256SUMS.txt.

DIR defaults to a folder next to the project: <project>_Release. Nothing is written inside the project.
"""
import argparse
import base64
import compileall
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile
from fnmatch import fnmatch
from py_compile import PycInvalidationMode

# compiled caches that do not depend on file times (the zip format keeps times to 2 s only)
UNCHECKED = PycInvalidationMode.UNCHECKED_HASH

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = 'FO4 Lightbox'                                     # the folder inside the zips
INCLUDE = ['Start Lightbox.bat', 'README.md', 'LICENSE',
           'server/*.py', 'server/vendor/*.py', 'server/vendor/README.md',
           'web/index.html', 'web/js/*.js', 'web/icon.png', 'web/about.jpg',
           'launcher/Launcher.cs', 'launcher/app.manifest', 'launcher/lightbox.ico', 'launcher/make_icon.py',
           'launcher/make_splash.py', 'launcher/splash/splash.html',
           'docs/DEVELOPMENT.md', 'docs/engine-notes.md', 'docs/weather-notes.md',
           'scenes/*.esp',
           'tools/capture.py', 'tools/check_clean.py', 'tools/build_simple_cell.py', 'tools/build_release.py',
           'tools/cloth_check.py', 'tools/credits.py']
# kept out on purpose: research notes about other people's tools, Bman's calibration setup and restart script,
# caches, the remembered game folder
EXCLUDE = ['.claude/*', '*/__pycache__/*', '*.pyc', 'docs/prior-art.md', 'tools/calibration/*',
           'tools/restart_lightbox.ps1', 'game_path.txt',
           'launcher/splash.png']           # rendered from launcher/splash/splash.html by make_splash.py; inside the exe

# standard library parts a server does not need
STDLIB_SKIP_DIRS = {'site-packages', 'test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'venv', 'pydoc_data',
                    '__phello__', '__pycache__'}
STDLIB_SKIP_FILES = {'turtle.py', '__hello__.py', 'antigravity.py', 'this.py'}
DLL_SKIP = ('_tkinter.pyd', 'tcl86t.dll', 'tk86t.dll', '_ctypes_test.pyd', '_test', 'winsound.pyd')
NUMPY_SKIP_DIRS = {'tests', '_pyinstaller', '__pycache__'}
NUMPY_SKIP_PATHS = {'_core/include', '_core/lib', 'random/lib', 'random/_examples'}
NUMPY_SKIP_EXT = ('.pyi', '.pxd', '.h', '.c', '.lib', '.a', '.pc', '.f', '.f90')
NUMPY_SKIP_FILES = ('_*_tests.*.pyd', '_*tests.*.pyd', '_simd.*.pyd')     # compiled modules only numpy's tests load
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


def build_runtime(dst, extra=()):
    if os.name != 'nt' or struct.calcsize('P') != 8:
        sys.exit('the runtime is built from a 64-bit Windows Python (run with --no-runtime elsewhere)')
    base = sys.base_prefix
    tag = f'{sys.version_info.major}{sys.version_info.minor}'
    os.makedirs(dst)
    for f in ('python.exe', 'python3.dll', f'python{tag}.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
        shutil.copy2(os.path.join(base, f), dst)
    shutil.copy2(os.path.join(base, 'LICENSE.txt'), os.path.join(dst, 'LICENSE-python.txt'))
    for f in sorted(os.listdir(os.path.join(base, 'DLLs'))):           # flat, like the embeddable package
        if f.lower().endswith(('.pyd', '.dll')) and not f.lower().startswith(DLL_SKIP):
            shutil.copy2(os.path.join(base, 'DLLs', f), dst)
    # the standard library as a plain folder, like a normal install, compiled once here for a fast first start
    lib, lib_dst = os.path.join(base, 'Lib'), os.path.join(dst, 'Lib')
    n = 0
    for dp, dn, fn in os.walk(lib):
        dn[:] = sorted(d for d in dn if d not in STDLIB_SKIP_DIRS)
        for f in sorted(fn):
            if not f.endswith('.py') or (dp == lib and f in STDLIB_SKIP_FILES):
                continue
            out = os.path.join(lib_dst, os.path.relpath(dp, lib), f)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(os.path.join(dp, f), out)
            n += 1
    if not compileall.compile_dir(lib_dst, quiet=1, invalidation_mode=UNCHECKED):
        sys.exit('compiling the standard library copy failed')
    import numpy
    np_dir = os.path.dirname(numpy.__file__)
    site = os.path.dirname(np_dir)
    sp = os.path.join(dst, 'site-packages')
    for dp, dn, fn in os.walk(np_dir):
        r0 = rel(dp, np_dir)
        dn[:] = [d for d in dn if d not in NUMPY_SKIP_DIRS and (r0 + '/' + d).lstrip('./') not in NUMPY_SKIP_PATHS]
        for f in fn:
            if f.lower().endswith(NUMPY_SKIP_EXT) or f.startswith('conftest.') or any(fnmatch(f, p) for p in NUMPY_SKIP_FILES):
                continue
            out = os.path.join(sp, 'numpy', os.path.relpath(dp, np_dir), f)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(os.path.join(dp, f), out)
    for d in [d for d in os.listdir(site) if d == 'numpy.libs' or re.fullmatch(r'numpy-[\d.]+\.dist-info', d)]:
        shutil.copytree(os.path.join(site, d), os.path.join(sp, d))
    if not compileall.compile_dir(os.path.join(sp, 'numpy'), quiet=1, invalidation_mode=UNCHECKED):
        sys.exit('compiling numpy failed')
    with open(os.path.join(dst, f'python{tag}._pth'), 'w', encoding='ascii', newline='\r\n') as f:
        f.write('Lib\n.\nsite-packages\n')
    pyver = '.'.join(map(str, sys.version_info[:3]))
    with open(os.path.join(dst, 'README.txt'), 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(f'''The Python that FO4 Lightbox runs on, so that nothing has to be installed.

Python {pyver} (64-bit) from https://www.python.org/ - licence: LICENSE-python.txt
numpy {numpy.__version__} from https://numpy.org/ - licences: site-packages/numpy-{numpy.__version__}.dist-info/licenses/

A trimmed copy (no tests, no tkinter / IDLE, no pip); the standard library is in Lib.
python{tag}._pth keeps it apart from any other Python on this PC (no PYTHONPATH, no user site-packages).
BINARIES.txt lists every executable file here with its SHA-256, its digital signature and its source.
Start Lightbox.bat uses it. Delete this folder to run the viewer on your own Python 3.10+ with numpy instead.
''')
    write_binaries(dst, pyver, numpy.__version__, site, extra)
    return pyver, numpy.__version__, n


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


def check_runtime(stage):
    py = os.path.join(stage, 'runtime', 'python.exe')
    probe = ('import sys, numpy, ssl, ctypes, sqlite3, json, gzip, mmap, zlib, winreg, msvcrt, urllib.request, '
             'webbrowser, http.server, xml.etree.ElementTree, dataclasses, typing, hashlib; '
             'print(sys.version.split()[0], numpy.__version__, sys.flags.isolated, sys.path)')
    r = subprocess.run([py, '-c', probe], env=clean_env(), cwd=stage, capture_output=True, text=True)
    if r.returncode:
        sys.exit('bundled runtime failed:\n' + r.stdout + r.stderr)
    print('  runtime:', r.stdout.strip())
    r = subprocess.run([py, os.path.join('server', 'app.py'), '--help'], env=clean_env(), cwd=stage,
                       capture_output=True, text=True)
    if r.returncode or 'FO4 Lightbox' not in r.stdout:
        sys.exit('server/app.py --help failed on the bundled runtime:\n' + r.stdout + r.stderr)
    print('  server/app.py --help: OK')


def write_zip(path, stage, skip_runtime):
    n = 0
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
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
        pyver, npver, n = build_runtime(os.path.join(stage, 'runtime'), extra)
        print(f'  runtime: Python {pyver} ({n} stdlib modules), numpy {npver}')
        check_runtime(stage)
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
        n = write_zip(path, stage, skip)
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
        z.extractall(dest)
    print(f'  unpacked to {app}')


if __name__ == '__main__':
    main()
