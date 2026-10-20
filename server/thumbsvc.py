"""Explorer thumbnails for .nif files (1.3.0).

The service (`app.py --thumbs`) is a hidden Lightbox server for Windows' thumbnail add-on (launcher/thumbs/
LightboxThumbs.cs). Explorer hands the add-on a NIF's bytes; it posts them to /api/thumb, a headless browser page
(web/thumb.html) draws the scene with the viewer's own renderer and posts the picture back. The service writes its port
to thumbs.port in the settings folder, stops once no thumbnail was asked for IDLE seconds, and its browser goes with it
(the service runs in a kill-on-close job object, which every process it starts joins: procjob.py).

The switch (File > Show .nif thumbnails in Explorer) is thumbreg.py: the add-on has to be registered machine-wide,
because Windows' thumbnail process ignores per-user COM registrations, so turning it on or off asks for admin rights.
"""
import os
import shutil
import subprocess
import sys
import threading
import time

IDLE = 300                       # seconds without a thumbnail request before the service stops
JOB_TIMEOUT = 60                 # seconds one thumbnail may take (the browser starting included)
BROWSERS = [r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
            r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe')]


def say(line):
    print(time.strftime('  %H:%M:%S ') + line, flush=True)


class Job:
    def __init__(self, jid, size, name, gz, view=None):
        self.id, self.size, self.name, self.gz = jid, size, name, gz
        self.view = view                 # 'yaw,pitch' in radians: a fixed view instead of the page's own choice (tests)
        self.done = threading.Event()
        self.png = None
        self.error = None
        self.taken = False


class Service:
    def __init__(self, settings_dir, port):
        self.dir, self.port = settings_dir, port
        self.cond = threading.Condition()
        self.waiting = []            # jobs the page has not taken yet
        self.jobs = {}               # id -> job, until answered
        self.next = 1
        self.browser = None
        self.browser_lock = threading.Lock()
        self.launches = 0
        self.started = -1e9          # when the browser was last started
        self.page_seen = -1e9        # when the page last asked for a job (it asks at least every 5 s while idle)
        self.profiles = os.path.join(settings_dir, 'thumbs-browser')
        shutil.rmtree(self.profiles, ignore_errors=True)     # (an earlier service's)
        self.port_file = os.path.join(settings_dir, 'thumbs.port')

    # ---------------------------------------------------------------- the add-on's side
    def render(self, gz, size, name, view=None):
        """The picture of one scene (its JSON, gzipped): PNG bytes, or raises RuntimeError."""
        with self.cond:
            job = Job(self.next, size, name, gz, view)
            self.next += 1
            self.jobs[job.id] = job
            self.waiting.append(job)
            self.cond.notify_all()
        try:
            self.ensure_browser()
            end = time.monotonic() + JOB_TIMEOUT
            while not job.done.wait(0.5):
                if time.monotonic() > end:
                    raise RuntimeError('the thumbnail page did not answer in time')
                self.ensure_browser()         # not started yet, or it went away: start it (again)
            if job.error:
                raise RuntimeError(job.error)
            return job.png
        finally:
            with self.cond:
                self.jobs.pop(job.id, None)
                if job in self.waiting:
                    self.waiting.remove(job)

    # ---------------------------------------------------------------- the page's side
    def take(self, timeout=15.0):
        """The next job for the page (long poll), or None."""
        end = time.monotonic() + timeout
        with self.cond:
            if self.page_seen < self.started:
                say(f'thumbnail page ready ({time.monotonic() - self.started:.1f} s after the browser started)')
            while True:
                self.page_seen = time.monotonic()
                if self.waiting:
                    job = self.waiting.pop(0)
                    job.taken = True
                    return job
                left = end - time.monotonic()
                if left <= 0:
                    return None
                self.cond.wait(min(left, 5.0))

    def scene(self, jid):
        with self.cond:
            job = self.jobs.get(jid)
        return job.gz if job else None

    def finish(self, jid, png=None, error=None, note=None):
        with self.cond:
            job = self.jobs.get(jid)
        if job:
            say(f'{job.name} ({job.size} px): {error or note or "done"}')
            job.png, job.error = png, error or (None if png else 'no picture')
            job.done.set()

    # ---------------------------------------------------------------- the headless browser
    def ensure_browser(self):
        # The process started hands over to the browser it spawns and ends, so the browser's life is judged by the
        # page asking for jobs. A new start gets its own profile folder: one with a browser still in it (hung) would
        # only hand the page over to that browser.
        with self.browser_lock:
            now = time.monotonic()
            if now - self.page_seen < 45 or now - self.started < 45:
                return
            if self.launches:                     # it went away: the jobs it held are handed out again
                say('the thumbnail page stopped asking for work: starting the browser again')
                with self.cond:
                    for job in self.jobs.values():
                        if job.taken and not job.done.is_set() and job not in self.waiting:
                            job.taken = False
                            self.waiting.append(job)
                    self.cond.notify_all()
            exe = next((b for b in BROWSERS if os.path.isfile(b)), None)
            if not exe:
                raise RuntimeError('neither Microsoft Edge nor Google Chrome was found')
            self.launches += 1
            self.started = now
            profile = os.path.join(self.profiles, str(self.launches))
            # private window, sync off: Edge would otherwise sign a fresh profile in with the Windows account
            private = '--inprivate' if 'msedge' in os.path.basename(exe).lower() else '--incognito'
            self.browser = subprocess.Popen(
                [exe, '--headless=new', private, '--disable-sync', '--window-size=64,64', '--hide-scrollbars',
                 '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
                 '--ignore-gpu-blocklist', f'--user-data-dir={profile}', f'http://127.0.0.1:{self.port}/thumb.html'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
            say(f'thumbnail browser started (pid {self.browser.pid})')

    def stop(self):
        # the browser's processes are in this process's kill-on-close job: they end with it
        try:
            with open(self.port_file, encoding='utf-8') as f:
                mine = f.read().split()[1:2] == [str(os.getpid())]
            if mine:
                os.remove(self.port_file)
        except (OSError, IndexError):
            pass

    def publish(self):
        os.makedirs(self.dir, exist_ok=True)
        tmp = self.port_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(f'{self.port} {os.getpid()}\n')
        os.replace(tmp, self.port_file)


def running(settings_dir):
    """The port of another thumbnail service that answers (two started at once: the second one leaves), or None."""
    import urllib.request
    try:
        with open(os.path.join(settings_dir, 'thumbs.port'), encoding='utf-8') as f:
            port = int(f.read().split()[0])
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/version', timeout=5) as r:
            return port if b'boot' in r.read() else None
    except (OSError, ValueError, IndexError):
        return None


def log_to(path):
    """The service runs without a console window: its output goes to a log in the settings folder."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    f = open(path, 'w', encoding='utf-8', buffering=1)
    sys.stdout = sys.stderr = f
