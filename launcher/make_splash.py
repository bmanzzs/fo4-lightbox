"""Renders the splash artwork launcher/splash/splash.html to launcher/splash.png (1600 x 1000, transparent around the
card so its shadow is soft) in headless Microsoft Edge, through the Chrome DevTools protocol (stdlib only).

    python launcher/make_splash.py [--out PATH]

The launcher embeds splash.png and draws the live parts (status, version, progress bar) on top of it.
"""
import argparse
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
EDGE = [r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        r'C:\Program Files\Microsoft\Edge\Application\msedge.exe']


class Page:
    """Just enough of a WebSocket + DevTools client to load one page and take one screenshot."""

    def __init__(self, ws_url):
        u = urlparse(ws_url)
        self.s = socket.create_connection((u.hostname, u.port), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n'
                        f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        self.buf = bytearray(buf.split(b'\r\n\r\n', 1)[1])
        self.n = 0

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise ConnectionError('closed')
            self.buf += chunk

    def _recv(self):
        parts = []
        while True:
            self._need(2)
            b0, b1 = self.buf[0], self.buf[1]
            n, off = b1 & 0x7F, 2
            if n == 126:
                self._need(4)
                n, off = struct.unpack('>H', self.buf[2:4])[0], 4
            elif n == 127:
                self._need(10)
                n, off = struct.unpack('>Q', self.buf[2:10])[0], 10
            self._need(off + n)
            parts.append(bytes(self.buf[off:off + n]))
            del self.buf[:off + n]
            if b0 & 0x80:
                return b''.join(parts).decode('utf-8')

    def call(self, method, **params):
        self.n += 1
        data = json.dumps({'id': self.n, 'method': method, 'params': params}).encode()
        mask = os.urandom(4)
        hdr = bytearray([0x81])
        if len(data) < 126:
            hdr.append(0x80 | len(data))
        else:
            hdr.append(0x80 | 126)
            hdr += struct.pack('>H', len(data))
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.s.sendall(bytes(hdr) + mask + body)
        while True:
            msg = json.loads(self._recv())
            if msg.get('id') == self.n:
                if 'error' in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get('result', {})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(HERE, 'splash.png'))
    a = ap.parse_args()
    sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'server'))
    from procjob import end_with_me
    end_with_me()                        # the headless browser started here ends with this script, however it ends
    exe = next((e for e in EDGE if os.path.isfile(e)), None)
    if not exe:
        raise SystemExit('Microsoft Edge not found')
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    profile = tempfile.mkdtemp(prefix='lightbox_splash_')
    p = subprocess.Popen([exe, '--headless=new', '--inprivate', '--disable-sync', f'--remote-debugging-port={port}',
                          '--remote-allow-origins=*', '--hide-scrollbars', '--no-first-run', '--disable-extensions',
                          '--force-color-profile=srgb', f'--user-data-dir={profile}', 'about:blank'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tabs = None
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=2))
                if any(t['type'] == 'page' for t in tabs):
                    break
            except OSError:
                time.sleep(0.25)
        tab = next(t for t in tabs if t['type'] == 'page' and not t['url'].startswith(('edge:', 'chrome:')))
        pg = Page(tab['webSocketDebuggerUrl'])
        pg.call('Emulation.setDeviceMetricsOverride', width=800, height=500, deviceScaleFactor=2, mobile=False)
        pg.call('Emulation.setDefaultBackgroundColorOverride', color={'r': 0, 'g': 0, 'b': 0, 'a': 0})
        pg.call('Page.navigate', url='file:///' + os.path.join(HERE, 'splash', 'splash.html').replace('\\', '/'))
        for _ in range(100):
            time.sleep(0.1)
            r = pg.call('Runtime.evaluate', expression='window.__ready === true', returnByValue=True)
            if r.get('result', {}).get('value'):
                break
        time.sleep(0.3)
        shot = pg.call('Page.captureScreenshot', format='png',
                       clip={'x': 0, 'y': 0, 'width': 800, 'height': 500, 'scale': 1})
        with open(a.out, 'wb') as f:
            f.write(base64.b64decode(shot['data']))
        print('wrote', a.out)
    finally:
        subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True)


if __name__ == '__main__':
    main()
