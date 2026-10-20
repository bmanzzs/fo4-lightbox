"""File > Show .nif thumbnails in Explorer: registers FO4 Lightbox's thumbnail add-on (LightboxThumbs.dll) with Windows,
or takes it out again.

Windows runs thumbnail add-ons in its own sandboxed process, which only sees machine-wide (HKLM) COM registrations, so
this needs admin rights: the viewer runs this file elevated (`python thumbreg.py on|off <dll> <result.json>`, one UAC
prompt) and reads the result it writes. The add-on is copied to Program Files first: Explorer keeps it loaded, and a
copy in the viewer's own folder would stop a mod manager from updating or removing the viewer. Each build gets its own
file name (a hash of its bytes), so turning thumbnails on again after an update never has to overwrite a loaded file.

Nothing else is changed: a .nif thumbnail handler that was there before is remembered and put back when switched off.
Stdlib only (it also runs on its own, elevated).
"""
import hashlib
import json
import os
import shutil
import sys

CLSID = '{04c52f43-6c03-495c-ad2e-75f1d570b40a}'
THUMB_IF = '{e357fccd-a995-4576-b01f-234630154e96}'           # IThumbnailProvider
ASSEMBLY = 'LightboxThumbs, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'
CLASS = 'FO4Lightbox.Thumbs.Provider'
NAME = 'FO4 Lightbox .nif thumbnails'
DOTNET_CATEGORY = '{62C8FE65-4EBB-45e7-B440-6E39B2CDBF29}'
CLSID_KEY = 'SOFTWARE\\Classes\\CLSID\\' + CLSID
SHELLEX = ['SOFTWARE\\Classes\\.nif\\ShellEx\\' + THUMB_IF,
           'SOFTWARE\\Classes\\SystemFileAssociations\\.nif\\ShellEx\\' + THUMB_IF]


def program_dir():
    return os.path.join(os.environ.get('ProgramFiles') or r'C:\Program Files', 'FO4 Lightbox Thumbnails')


def _reg():
    import winreg
    return winreg


def _read(key, name='', view=0):
    winreg = _reg()
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key, 0, winreg.KEY_READ | view) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def state():
    """{on, dll}: on when .nif files point at this add-on and its file is there (readable without admin rights)."""
    try:
        _reg()
    except ImportError:
        return dict(on=False, dll=None)
    code = _read(CLSID_KEY + '\\InprocServer32', 'CodeBase') or ''
    dll = code[8:].replace('/', '\\') if code.lower().startswith('file:///') else None
    on = _read(SHELLEX[0]) == CLSID and bool(dll and os.path.isfile(dll))
    return dict(on=on, dll=dll)


def _put(key, values, view=0):
    winreg = _reg()
    with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, key, 0, winreg.KEY_WRITE | view) as k:
        for name, value in values.items():
            winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)


def _delete_tree(key, view=0):
    winreg = _reg()
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key, 0, winreg.KEY_READ | view) as k:
            subs = []
            i = 0
            while True:
                try:
                    subs.append(winreg.EnumKey(k, i))
                except OSError:
                    break
                i += 1
        for s in subs:
            _delete_tree(key + '\\' + s, view)
        winreg.DeleteKeyEx(winreg.HKEY_LOCAL_MACHINE, key, view, 0)
    except OSError:
        pass


def _views():
    winreg = _reg()
    return [winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY]        # 64-bit Explorer, and 32-bit programs' file dialogs


def _notify():
    import ctypes
    ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)   # SHCNE_ASSOCCHANGED: Explorer reads it again


def _remove_file(path):
    try:
        os.remove(path)
    except OSError:                                   # loaded by Explorer: gone after the next restart
        import ctypes
        ctypes.windll.kernel32.MoveFileExW(path, None, 4)          # MOVEFILE_DELAY_UNTIL_REBOOT


def install(dll_src):
    with open(dll_src, 'rb') as f:
        data = f.read()
    folder = program_dir()
    os.makedirs(folder, exist_ok=True)
    dll = os.path.join(folder, f'LightboxThumbs.{hashlib.sha256(data).hexdigest()[:10]}.dll')
    if not os.path.isfile(dll):
        tmp = dll + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, dll)
    for view in _views():
        k = CLSID_KEY
        _put(k, {'': NAME}, view)
        _put(k + '\\Implemented Categories\\' + DOTNET_CATEGORY, {}, view)
        _put(k + '\\InprocServer32', {'': 'mscoree.dll', 'ThreadingModel': 'Both', 'Class': CLASS,
                                      'Assembly': ASSEMBLY, 'RuntimeVersion': 'v4.0.30319',
                                      'CodeBase': 'file:///' + dll.replace('\\', '/')}, view)   # unescaped, as regasm
    for key in SHELLEX:
        prev = _read(key)
        if prev and prev.lower() != CLSID.lower():
            _put(CLSID_KEY, {'Previous ' + key.split('\\')[2]: prev})
        _put(key, {'': CLSID})
    for name in os.listdir(folder):                   # earlier builds (one Explorer still holds waits for a restart)
        p = os.path.join(folder, name)
        if name.lower().startswith('lightboxthumbs.') and name.lower().endswith('.dll') and \
                os.path.normcase(p) != os.path.normcase(dll):
            _remove_file(p)
    _notify()
    return dll


def uninstall():
    for key in SHELLEX:
        if (_read(key) or '').lower() != CLSID.lower():
            continue                                  # (another handler took .nif over since: left alone)
        prev = _read(CLSID_KEY, 'Previous ' + key.split('\\')[2])
        if prev:
            _put(key, {'': prev})
        else:
            _delete_tree(key)
    for view in _views():
        _delete_tree(CLSID_KEY, view)
    folder = program_dir()
    if os.path.isdir(folder):
        for name in os.listdir(folder):
            _remove_file(os.path.join(folder, name))
        try:
            os.rmdir(folder)
        except OSError:
            pass
    _notify()


def switch(on, dll_src):
    """Turn the add-on on or off from the (not elevated) viewer: one UAC prompt. Returns state(), or raises."""
    import ctypes
    import tempfile
    from ctypes import wintypes
    if on and not os.path.isfile(dll_src or ''):
        raise FileNotFoundError('LightboxThumbs.dll is not in this copy of FO4 Lightbox (the version without '
                                'Python has no Explorer thumbnails)')
    fd, result = tempfile.mkstemp(prefix='lightbox_thumbs_', suffix='.json')
    os.close(fd)
    os.remove(result)

    class Info(ctypes.Structure):
        _fields_ = [('cbSize', wintypes.DWORD), ('fMask', wintypes.ULONG), ('hwnd', wintypes.HWND),
                    ('lpVerb', wintypes.LPCWSTR), ('lpFile', wintypes.LPCWSTR), ('lpParameters', wintypes.LPCWSTR),
                    ('lpDirectory', wintypes.LPCWSTR), ('nShow', ctypes.c_int), ('hInstApp', wintypes.HINSTANCE),
                    ('lpIDList', ctypes.c_void_p), ('lpClass', wintypes.LPCWSTR), ('hkeyClass', wintypes.HKEY),
                    ('dwHotKey', wintypes.DWORD), ('hIcon', wintypes.HANDLE), ('hProcess', wintypes.HANDLE)]
    exe = sys.executable
    if os.path.basename(exe).lower() == 'pythonw.exe':
        exe = os.path.join(os.path.dirname(exe), 'python.exe')
    args = ' '.join(f'"{a}"' for a in ['-X', 'utf8', os.path.abspath(__file__), 'on' if on else 'off',
                                       os.path.abspath(dll_src) if on else '-', result])
    info = Info(cbSize=ctypes.sizeof(Info), fMask=0x40 | 0x400, lpVerb='runas', lpFile=exe,  # NOCLOSEPROCESS, NOASYNC
                lpParameters=args, nShow=0)
    shell32 = ctypes.WinDLL('shell32', use_last_error=True)
    if not shell32.ShellExecuteExW(ctypes.byref(info)):
        err = ctypes.get_last_error()
        if err == 1223:                               # ERROR_CANCELLED: No on the UAC prompt
            raise PermissionError('cancelled: Windows asks for admin rights once to change Explorer thumbnails')
        raise OSError(f'could not start the registration (error {err})')
    k32 = ctypes.windll.kernel32
    k32.WaitForSingleObject(info.hProcess, 60000)
    k32.CloseHandle(info.hProcess)
    try:
        with open(result, encoding='utf-8') as f:
            r = json.load(f)
        os.remove(result)
    except (OSError, ValueError):
        r = {'error': 'the registration did not finish'}
    if r.get('error'):
        raise RuntimeError(r['error'])
    return state()


def set_user_paths(python, app):
    """Where the add-on finds the viewer to start its thumbnail service (this user): kept up to date by each start
    of the viewer while thumbnails are on, so a moved or updated copy is the one used. Written to thumbs.paths in the
    settings folder, which the add-on reads first: the Python from the Microsoft Store / Python install manager runs
    packaged, and Windows keeps a packaged program's registry writes to itself (its files are written for real).
    The registry values are kept for add-ons from before."""
    folder = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), 'FO4 Lightbox')
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, 'thumbs.paths'), 'w', encoding='utf-8') as f:
        f.write(f'{python}\n{app}\n')
    import winreg
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, r'Software\FO4 Lightbox', 0, winreg.KEY_WRITE) as k:
        winreg.SetValueEx(k, 'ThumbsPython', 0, winreg.REG_SZ, python)
        winreg.SetValueEx(k, 'ThumbsApp', 0, winreg.REG_SZ, app)


def main():
    what, dll, result = sys.argv[1:4]
    try:
        if what == 'on':
            r = {'dll': install(dll)}
        else:
            uninstall()
            r = {'off': True}
    except Exception as e:
        r = {'error': f'{type(e).__name__}: {e}'}
    with open(result, 'w', encoding='utf-8') as f:
        json.dump(r, f)


if __name__ == '__main__':
    main()
