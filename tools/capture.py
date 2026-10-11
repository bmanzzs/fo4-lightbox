"""Render a model with Lightbox in a headless browser and save PNGs, a contact sheet and a manifest.

Starts its own Lightbox server (a free port, --save-dir = the output folder), opens the page in headless Edge or
Chrome with a capture spec, waits for <name>_manifest.json, then stops the browser and server it started.

Examples:
    python tools/capture.py --out C:\\shots --nif "meshes\\armor\\raider03\\raiderbody03mb.nif" --ref m --suit
    python tools/capture.py --out C:\\shots --file C:\\exports\\MyPackM.nif --ref m --suit --lighting noon,night
    python tools/capture.py --out C:\\shots --armor Armor_Combat_Torso --variant "Brotherhood of Steel" --sex f --suit
    python tools/capture.py --out C:\\shots --armor Armor_Combat_Torso --ground --ref none
    (with the release zip, use runtime\\python.exe instead of python)

Lighting presets: noon, morning, evening, night, overcast, rain, foggy, glowingsea, radstorm, studio, or WEATHER@HOUR
(e.g. Clear@15). Cameras: front, back, left, right, three (3/4 back), threefront, top, below (from behind and under),
belowfront. The manifest lists every shot with its mean luminance and the share of blown / crushed pixels, the
GPU used, the item's resolved armature, model files and material swaps, and every warning (missing textures...).
"""
import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BROWSERS = [r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
            r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe')]


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def get(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def wait_ready(base, need_world, deadline):
    while time.time() < deadline:
        try:
            st = get(base + '/api/status')
            pres = get(base + '/api/weather/presets').get('presets')
            world = (not need_world) or not get(base + '/api/armors?q=zzzz').get('error')
            if st and pres and world:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def lighting_list(text):
    out = []
    for t in [x.strip() for x in text.split(',') if x.strip()]:
        if '@' in t:
            w, h = t.split('@', 1)
            out.append({'weather': w, 'hour': float(h)})
        else:
            out.append(t)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='Lightbox capture: render a model to PNGs in a headless browser.')
    ap.add_argument('--out', required=True, help='output folder (created)')
    ap.add_argument('--name', default=None, help='file name prefix (default: from the model)')
    ap.add_argument('--nif', action='append', default=[], help='mesh path inside Data (loose or BA2); repeatable')
    ap.add_argument('--file', action='append', default=[], help='a .nif anywhere on disk (fresh export); repeatable')
    ap.add_argument('--armor', help='ARMO EditorID or FormID: loads what the plugin record points to')
    ap.add_argument('--variant', default='default', help='OMOD variant name / EditorID (with --armor)')
    ap.add_argument('--sex', choices=['m', 'f'], help='which worn model (with --armor; default = --ref)')
    ap.add_argument('--ground', action='store_true', help='with --armor: the ground (world) model instead')
    ap.add_argument('--ref', default='m', choices=['m', 'f', 'none'], help='reference body (default m)')
    ap.add_argument('--suit', action='store_true', help='dress the reference body in the Vault 111 suit (= --outfit vault)')
    ap.add_argument('--outfit', choices=['vault', 'leathers', 'radstag'],
                    help='dress the reference body: Vault 111 suit, Road Leathers or Radstag Hide Outfit')
    ap.add_argument('--pose', default='auto', help="'auto' (relaxed idle), 'bind', or a clip id such as idle_f")
    ap.add_argument('--worn', default='yes', choices=['yes', 'no'], help='--nif/--file worn on the body (default) or standalone')
    ap.add_argument('--lighting', default='noon,glowingsea,night')
    ap.add_argument('--cameras', default='three,front,left,below')
    ap.add_argument('--frame', default='item', choices=['item', 'body'], help='frame the item or the whole body')
    ap.add_argument('--size', default='1600x1200')
    ap.add_argument('--ss', type=float, default=1.0, help='supersampling factor (2 = render at twice the size)')
    ap.add_argument('--fov', type=float, default=55)
    ap.add_argument('--no-sheet', action='store_true')
    ap.add_argument('--game', help='Fallout 4 folder (auto-detected if omitted)')
    ap.add_argument('--browser', help='path to msedge.exe / chrome.exe (auto-detected if omitted)')
    ap.add_argument('--timeout', type=float, default=240)
    a = ap.parse_args(argv)

    if not (a.nif or a.file or a.armor):
        ap.error('give --nif, --file or --armor')
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    W, H = (int(x) for x in a.size.lower().split('x'))
    name = a.name or os.path.splitext(os.path.basename((a.file or a.nif or [a.armor or 'capture'])[0].replace('\\', '/')))[0]
    spec = {'name': name, 'ref': a.ref, 'outfit': a.outfit or ('vault' if a.suit else ''), 'pose': a.pose, 'worn': a.worn == 'yes',
            'nifs': a.nif, 'files': [os.path.abspath(f) for f in a.file], 'lighting': lighting_list(a.lighting),
            'cameras': [c.strip() for c in a.cameras.split(',') if c.strip()], 'frame': a.frame,
            'size': [W, H], 'ss': a.ss, 'fov': a.fov, 'sheet': not a.no_sheet}
    if a.armor:
        spec['armor'] = {'id': a.armor, 'variant': a.variant, 'sex': a.sex or (a.ref if a.ref != 'none' else 'm'),
                         'ground': a.ground}
    manifest_path = os.path.join(out, f'{name}_manifest.json')
    if os.path.exists(manifest_path):
        os.remove(manifest_path)

    browser = a.browser or next((b for b in BROWSERS if os.path.isfile(b)), None)
    if not browser:
        sys.exit('no Edge or Chrome found; pass --browser')
    port = free_port()
    base = f'http://127.0.0.1:{port}'
    srv_cmd = [sys.executable, os.path.join(ROOT, 'server', 'app.py'), '--no-browser', '--port', str(port), '--save-dir', out]
    if a.game:
        srv_cmd += ['--game', a.game]
    log = open(os.path.join(out, f'{name}_server.log'), 'w', encoding='utf-8')
    srv = subprocess.Popen(srv_cmd, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT)
    profile = tempfile.mkdtemp(prefix='lightbox_capture_')
    br = None
    t0 = time.time()
    try:
        if not wait_ready(base, bool(a.armor), t0 + 90):
            sys.exit(f'the Lightbox server did not come up (see {name}_server.log)')
        code = base64.urlsafe_b64encode(json.dumps(spec).encode('utf-8')).decode('ascii').rstrip('=')
        url = f'{base}/?capture={code}'
        # private window, sync off: Edge would otherwise sign the fresh profile in with the Windows account
        private = '--inprivate' if 'msedge' in os.path.basename(browser).lower() else '--incognito'
        br = subprocess.Popen([browser, '--headless=new', private, '--disable-sync', f'--window-size={W},{H}',
                               '--force-device-scale-factor=1', '--hide-scrollbars', '--no-first-run',
                               '--no-default-browser-check', '--disable-extensions', '--mute-audio',
                               '--ignore-gpu-blocklist', f'--user-data-dir={profile}', url],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        while time.time() < t0 + a.timeout and not os.path.exists(manifest_path):
            time.sleep(0.5)
        if not os.path.exists(manifest_path):
            sys.exit(f'timed out after {a.timeout:.0f} s without {os.path.basename(manifest_path)}')
        time.sleep(0.3)
        m = json.load(open(manifest_path, encoding='utf-8'))
    finally:
        if br is not None:                       # only the browser and server this script started
            subprocess.run(['taskkill', '/PID', str(br.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        srv.terminate()
        try:
            srv.wait(10)
        except subprocess.TimeoutExpired:
            srv.kill()
        log.close()
        shutil.rmtree(profile, ignore_errors=True)

    print(f'{len(m.get("shots", []))} shots in {time.time() - t0:.1f} s  ->  {out}')
    print(f'GPU: {m.get("gpu")}')
    if m.get('item'):
        it = m['item']
        print(f'item: {it["name"]} [{it["edid"]}] ({it["plugin"]}) variant {it["variant"]}, addon {it["addon_index"]}, armature {it["arma"]}')
        for k, f in (it.get('models') or {}).items():
            print(f'   {k:11s} {f.get("path")}  [{f.get("source") or "MISSING"}]')
    for s in m.get('shots', []):
        print(f'   {s["file"]}: mean {s["mean_luma"]}, blown {s["blown_pct"]}%, crushed {s["crushed_pct"]}%')
    if m.get('sheet'):
        print(f'sheet: {m["sheet"]}')
    for w in m.get('warnings', []):
        print('WARNING', w)
    if m.get('error'):
        print('ERROR', m['error'])
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
