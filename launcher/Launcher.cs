// FO4 Lightbox.exe: starts the viewer's local server without a console window and opens the viewer in its own app
// window (Microsoft Edge or Google Chrome "app" mode: no tabs, no address bar). Closing that window stops the server.
//
// Built by tools/build_release.py with the C# compiler that ships with Windows (.NET Framework 4, C# 5):
//     csc /target:winexe /win32icon:launcher\lightbox.ico /win32manifest:launcher\app.manifest
//         /resource:launcher\lightbox.ico,lightbox.ico /resource:launcher\splash.png,splash.png
//         /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Management.dll launcher\Launcher.cs <AssemblyInfo>
//
// While it starts, a splash window shows the artwork (launcher/splash.png, rendered from launcher/splash/splash.html)
// with the live status and a progress bar that follows the real steps: Python, the archive index, weather, the
// cell / record index, the mesh list (the server's /api/ready), then the viewer's window.
//
// What it does, in order (on a worker thread; the splash animates on the UI thread):
//   1. A viewer already answering on the port (another start): just open a window on it.
//   2. Otherwise start runtime\python.exe server\app.py (or the PC's own Python 3 when there is no runtime folder)
//      hidden, with its output in %LOCALAPPDATA%\FO4 Lightbox\server.log, and wait until it has loaded.
//   3. Fallout 4 not found: ask for the folder (kept in %LOCALAPPDATA%\FO4 Lightbox\game_path.txt), start again.
//   4. Open the window (its own browser profile in %LOCALAPPDATA%\FO4 Lightbox\browser), wait until it closes (also
//      when Edge hands it to another of its processes: see the wait loop), then stop the server. No Edge or Chrome: the default browser instead, and the server stops a few minutes after the
//      last page is gone (--exit-when-idle).
// Arguments are passed on to the server (--game, --port, --plugin ...); --choose-game asks for the game folder again.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Launcher
{
    const string Title = "FO4 Lightbox";
    const int IdleSeconds = 180;          // the server's own stop when no page is left (a minimised page still asks)

    static string root, home, logPath, profileDir;
    static StreamWriter log;
    static readonly object logLock = new object();
    static readonly StringBuilder tail = new StringBuilder();
    static SplashWindow ui;

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [STAThread]
    static int Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch (Exception) { }
        try { SetCurrentProcessExplicitAppUserModelID(AppId); } catch (Exception) { }    // one button with the window
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        WebRequest.DefaultWebProxy = null;                   // local requests only: skip the proxy lookup
        root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        // %LOCALAPPDATA% as the server reads it (the same folder normally; a test can point both elsewhere)
        string la = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (string.IsNullOrEmpty(la)) la = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        home = Path.Combine(la, Title);
        try { Directory.CreateDirectory(home); }
        catch (Exception) { home = Path.Combine(Path.GetTempPath(), Title); Directory.CreateDirectory(home); }
        logPath = Path.Combine(home, "server.log");

        if (args.Length >= 4 && args[0] == "--render-splash")
        {
            double pr, at = 0.7;
            double.TryParse(args[2], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out pr);
            if (args.Length >= 5) double.TryParse(args[4], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out at);
            try
            {
                using (SplashWindow s = new SplashWindow(Version())) s.Snapshot(args[1], pr, args[3], at);
            }
            catch (Exception e) { File.WriteAllText(args[1] + ".error.txt", e.ToString()); return 1; }
            return 0;
        }
        if (!File.Exists(Path.Combine(root, "server", "app.py")))
        {
            Fail("The viewer's files are missing next to FO4 Lightbox.exe.\n\nExtract the whole zip to a folder and start "
                 + "FO4 Lightbox.exe from there (it cannot run from inside the zip).");
            return 1;
        }

        ui = new SplashWindow(Version());
        int code = 0;
        Thread worker = new Thread(delegate()
        {
            try { code = Run(args); }
            catch (Exception e) { Fail("FO4 Lightbox could not start: " + e.Message); code = 1; }
            finally { ui.Done(); }
        });
        worker.SetApartmentState(ApartmentState.STA);       // dialogs (folder picker, messages) open from here
        ui.Shown += delegate { worker.Start(); };
        Application.Run(ui);                                 // until the splash has faded out
        worker.Join();                                       // the worker waits for the viewer's window to close
        return code;
    }

    static string Version()
    {
        object[] a = Assembly.GetExecutingAssembly().GetCustomAttributes(typeof(AssemblyInformationalVersionAttribute), false);
        return a.Length > 0 ? ((AssemblyInformationalVersionAttribute)a[0]).InformationalVersion : "";
    }

    // ------------------------------------------------------------------------------------------- startup (worker)
    static int Run(string[] args)
    {
        List<string> pass = new List<string>();
        int port = 8765;
        bool chooseGame = false;
        string game = null, openFile = null;
        bool handed = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length) { int.TryParse(args[++i], out port); continue; }
            if (args[i] == "--choose-game") { chooseGame = true; continue; }
            if (args[i] == "--game" && i + 1 < args.Length) { game = args[++i]; continue; }
            // a .nif given to the exe (a double-click, Windows' Open with): handed to the viewer once it is up
            if (args[i].EndsWith(".nif", StringComparison.OrdinalIgnoreCase) && File.Exists(args[i]))
            { openFile = Path.GetFullPath(args[i]); continue; }
            pass.Add(args[i]);
        }
        if (game == null && !chooseGame) game = SavedGame();

        ui.Set(0.03, "Starting…");
        Process server = null;
        if (IsLightbox(port))
        {
            ui.Set(0.85, "Joining the viewer that is already running…");
            // a file for a viewer whose window is open: that window loads it and comes to the front
            if (openFile != null)
            {
                string title;
                handed = true;
                if (HandOver(port, openFile, out title) && Activate(title))
                {
                    ui.Set(1, "Opened in the viewer");
                    ui.Done();
                    return 0;
                }
            }
        }
        else
        {
            if (!PortFree(port)) port = FreePort(port + 1);
            for (int attempt = 0; ; attempt++)
            {
                if (chooseGame)
                {
                    ui.SetVisible(false);
                    game = AskGame(game);
                    if (game == null) return 0;
                    ui.SetVisible(true);
                    chooseGame = false;
                }
                ui.Set(0.08, "Starting Python…");
                server = StartServer(port, game, pass);
                if (server == null) return 1;
                string result = WaitReady(server, port);
                if (result == "ready") break;
                string output = Tail();
                if (output.Contains("Fallout 4 was not found") && attempt < 3)
                {
                    chooseGame = true;                    // ask, then try again with the folder picked
                    continue;
                }
                if (result == "timeout") Stop(server);
                Fail("The viewer's server stopped before it was ready.\n\n" + LastLines(output, 12)
                     + "\n\nThe whole log: " + logPath);
                return 1;
            }
        }

        string url = "http://127.0.0.1:" + port + "/";
        string ignored;
        if (openFile != null && !handed) HandOver(port, openFile, out ignored);   // the window about to open loads it once started
        ui.Set(0.95, "Opening the viewer…");
        Process window = OpenWindow(url);
        if (window == null)
        {
            try { Process.Start(url); }                    // no Edge or Chrome: the default browser
            catch (Exception e) { Fail("Could not open a browser: " + e.Message + "\n\nOpen " + url + " yourself."); }
            ui.Set(1, "Opened in your browser");
            return 0;                                      // the server stops by itself once the page is closed
        }
        WaitForWindow(window);
        StampWindows(window);
        ui.Set(1, "Ready");
        ui.Done();
        // the next seconds too: the window may only appear (or be made again) once the page loads
        for (int i = 0; i < 20; i++) { Thread.Sleep(250); StampWindows(window); }
        if (server == null) return 0;                      // a viewer that was already running keeps running

        // wait for the window to close, then stop the server. A server that stops while the window is still open (its
        // idle stop after the PC slept, a crash) starts again on the same port: the page reloads and puts the scene
        // back instead of ending on "127.0.0.1 refused to connect".
        // "The window is open" = the Edge process started above is alive, or a visible window of an Edge / Chrome
        // process running on the viewer's own profile is. Edge hands the window to another process of its own and
        // the first one exits at once (on a fresh profile, a first start; or to one still running on the profile):
        // 1.2.0 / 1.3.0 then stopped the server under an open page, which hung on "Loading…". A few seconds' grace
        // for a window still appearing
        int restarts = 0, ticks = 0;
        DateTime seen = DateTime.Now;
        while (true)
        {
            if (server.HasExited)
            {
                if (window.HasExited && !WindowOpen()) return 0;
                if (++restarts > 5)
                {
                    if (server.ExitCode != 0)
                        Fail("The viewer's server stopped unexpectedly.\n\n" + LastLines(Tail(), 12) + "\n\nThe whole log: " + logPath);
                    return 0;
                }
                server = StartServer(port, game, pass);
                if (server == null || WaitReady(server, port) != "ready")
                {
                    Fail("The viewer's server stopped and could not start again.\n\n" + LastLines(Tail(), 12) + "\n\nThe whole log: " + logPath);
                    return 1;
                }
                continue;
            }
            if (!window.WaitForExit(500))
            {
                seen = DateTime.Now;
                if (++ticks % 4 == 0) StampWindows(window);    // (cheap when stamped; catches a window Edge made again)
                continue;
            }
            if (WindowOpen()) seen = DateTime.Now;              // (stamps it too: the taskbar button after a hand-over)
            else if ((DateTime.Now - seen).TotalSeconds > 8) break;
            Thread.Sleep(1000);
        }
        Stop(server);
        return 0;
    }

    // a visible top-level window of a browser process on the viewer's own profile (whichever process Edge gave the
    // window to), or one already carrying the viewer's taskbar ID. Found ones are stamped with that ID
    static bool WindowOpen()
    {
        HashSet<uint> pids = ProfilePids();
        bool found = false;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;     // (GW_OWNER: menus, popups)
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (pids.Contains(p))
            {
                // an app window's title is the page's alone; an ordinary browser window on the profile (" - Microsoft
                // Edge", with a zero-width space in it) is not the viewer
                string t = WindowText(h).Replace("​", "");
                if (t.EndsWith("Microsoft Edge") || t.EndsWith("Google Chrome")) return true;
                Stamp(h); found = true; return false;
            }
            IPropertyStore store = null;
            try
            {
                Guid iid = typeof(IPropertyStore).GUID;
                if (SHGetPropertyStoreForWindow(h, ref iid, out store) == 0 && store != null && ReadString(store, KeyId) == AppId)
                {
                    found = true;
                    return false;
                }
            }
            catch (Exception) { }
            finally { if (store != null) Marshal.ReleaseComObject(store); }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // the browser processes whose command line names the viewer's profile folder (WMI; about 0.1 s, asked at most
    // once a second, only after the started process has gone)
    static HashSet<uint> ProfilePids()
    {
        HashSet<uint> set = new HashSet<uint>();
        if (profileDir == null) return set;
        try
        {
            using (ManagementObjectSearcher s = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe' OR Name='chrome.exe'"))
            using (ManagementObjectCollection all = s.Get())
            {
                foreach (ManagementBaseObject o in all)
                {
                    using (o)
                    {
                        string cl = o["CommandLine"] as string;
                        if (cl != null && cl.IndexOf(profileDir, StringComparison.OrdinalIgnoreCase) >= 0)
                            set.Add(Convert.ToUInt32(o["ProcessId"]));
                    }
                }
            }
        }
        catch (Exception) { }
        return set;
    }

    static void WaitForWindow(Process window)
    {
        DateTime end = DateTime.Now.AddSeconds(20);
        while (DateTime.Now < end)
        {
            try
            {
                if (window.HasExited) return;               // handed to a browser that was already open
                window.Refresh();
                if (window.MainWindowHandle != IntPtr.Zero) { Thread.Sleep(350); return; }   // a moment to paint
            }
            catch (Exception) { return; }
            Thread.Sleep(80);
        }
    }

    // ------------------------------------------------------------------------------------------- server
    static Process StartServer(int port, string game, List<string> pass)
    {
        string exe, prefix = "";
        string runtime = Path.Combine(root, "runtime", "python.exe");
        if (File.Exists(runtime)) exe = runtime;
        else
        {
            exe = FindOnPath("py.exe");
            if (exe != null) prefix = "-3 ";
            else exe = FindOnPath("python.exe");
            if (exe == null)
            {
                Fail("Python was not found.\n\nThe main download includes it in the runtime folder: extract the whole zip "
                     + "again. The download without Python needs Python 3.10 or newer with numpy installed.");
                return null;
            }
        }
        StringBuilder a = new StringBuilder(prefix + "-X utf8 -u " + Quote(Path.Combine(root, "server", "app.py"))
                                            + " --no-browser --port " + port + " --exit-when-idle " + IdleSeconds);
        if (!string.IsNullOrEmpty(game)) a.Append(" --game " + Quote(game));
        foreach (string p in pass) a.Append(" " + Quote(p));

        ProcessStartInfo psi = new ProcessStartInfo(exe, a.ToString());
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = true;                  // no console to ask questions in: the launcher asks instead
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        lock (logLock)
        {
            if (log != null) log.Dispose();
            tail.Length = 0;
            log = new StreamWriter(logPath, false, new UTF8Encoding(false));
            log.AutoFlush = true;
            log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + exe + " " + a);
        }
        Process p2;
        try { p2 = Process.Start(psi); }
        catch (Exception e)
        {
            Fail("Could not start the viewer's server: " + e.Message);
            return null;
        }
        p2.OutputDataReceived += OnOutput;
        p2.ErrorDataReceived += OnOutput;
        p2.BeginOutputReadLine();
        p2.BeginErrorReadLine();
        try { p2.StandardInput.Close(); } catch (Exception) { }
        return p2;
    }

    static readonly Regex Indexed = new Regex(@"(\d+) archives, ([\d,]+) archived files indexed");
    static readonly Regex Mo2Profile = new Regex("Mod Organizer 2: profile \"(.+?)\" of .+? \\((\\d+) mods? enabled\\)");
    static readonly Regex Mo2Indexed = new Regex(@"(\d+) mods?: ([\d,]+) loose files indexed");

    static void OnOutput(object sender, DataReceivedEventArgs e)
    {
        if (e.Data == null) return;
        lock (logLock)
        {
            if (log != null) log.WriteLine(e.Data);
            tail.AppendLine(e.Data);
            if (tail.Length > 20000) tail.Remove(0, tail.Length - 20000);
        }
        // the server's start-up lines move the progress bar
        if (e.Data.StartsWith("FO4 Lightbox ")) ui.Set(0.16, "Found Fallout 4. Reading the archive index…");
        Match p = Mo2Profile.Match(e.Data);
        if (p.Success)
            ui.Set(0.2, "Reading Mod Organizer 2 · " + p.Groups[1].Value + " (" + p.Groups[2].Value +
                   (p.Groups[2].Value == "1" ? " mod)…" : " mods)…"));
        Match l = Mo2Indexed.Match(e.Data);
        if (l.Success) ui.Set(0.3, "Indexed " + l.Groups[2].Value + " loose files in " + l.Groups[1].Value + " mods");
        Match m = Indexed.Match(e.Data);
        if (m.Success) ui.Set(0.42, "Indexed " + m.Groups[2].Value + " files in " + m.Groups[1].Value + " archives");
    }

    static string Tail()
    {
        lock (logLock) return tail.ToString();
    }

    static string WaitReady(Process server, int port)
    {
        DateTime end = DateTime.Now.AddSeconds(150), upAt = DateTime.MinValue;
        bool up = false;
        while (DateTime.Now < end)
        {
            if (server.HasExited) { server.WaitForExit(); return "exited"; }
            if (!up)
            {
                if (IsLightbox(port)) { up = true; upAt = DateTime.Now; ui.Set(0.5, "Reading weather and imagespace…"); }
            }
            else
            {
                string r = Get(port, "/api/ready") ?? "";
                bool weather = Regex.IsMatch(r, "\"weather\":\\s*true"), world = Regex.IsMatch(r, "\"world\":\\s*true"),
                     meshes = Regex.IsMatch(r, "\"meshes\":\\s*true");
                if (weather && !world) ui.Set(0.64, "Indexing cells and records…");
                if (weather && world && !meshes) ui.Set(0.82, "Listing meshes…");
                if (weather && world && meshes) { ui.Set(0.9, "Loaded"); return "ready"; }
                if ((DateTime.Now - upAt).TotalSeconds > 60) return "ready";     // the page waits for the rest
            }
            Thread.Sleep(100);
        }
        return up ? "ready" : "timeout";
    }

    static void Stop(Process p)
    {
        try { if (!p.HasExited) { p.Kill(); p.WaitForExit(3000); } } catch (Exception) { }
    }

    static string Get(int port, string path)
    {
        try
        {
            HttpWebRequest r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
            r.Timeout = 1500;
            r.Proxy = null;
            using (WebResponse resp = r.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream()))
                return sr.ReadToEnd();
        }
        catch (Exception) { return null; }
    }

    // ------------------------------------------------------------------------------------------- Open with
    // the file goes to the server's queue (/api/open); true when a page asked lately (title: its window's title)
    static bool HandOver(int port, string file, out string title)
    {
        title = null;
        string r = Get(port, "/api/open?path=" + Uri.EscapeDataString(file));
        if (r == null) return false;
        Match t = Regex.Match(r, "\"title\":\"((?:[^\"\\\\]|\\\\.)*)\"");
        if (t.Success) title = Regex.Unescape(t.Groups[1].Value);
        return r.Contains("\"page\":true");
    }

    // the viewer's window (Edge / Chrome in app mode: its title is the page's) restored and brought to the front
    static bool Activate(string title)
    {
        if (string.IsNullOrEmpty(title)) return false;
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            string w = sb.ToString();
            if (w == title || w.StartsWith(title + " - ")) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return false;
        Stamp(found);                                         // (a window from before 1.2.0, or one Edge made again)
        if (IsIconic(found)) ShowWindow(found, 9);            // SW_RESTORE
        SetForegroundWindow(found);
        return true;
    }

    // ------------------------------------------------------------------------------------------- the taskbar button
    // An Edge / Chrome app window carries the browser's AppUserModelID, so Windows put the viewer's window under the
    // Edge button. The launcher stamps the window's property store (SHGetPropertyStoreForWindow works on another
    // process's window) with its own ID, plus the relaunch command, name and icon a pin of the window uses; the
    // launcher process takes the same ID, so the splash, the window and such a pin share one button. The window keeps
    // the page's favicon (the same cube), so no icon is forced on it. A pin of FO4 Lightbox.exe made before 1.2.0 has
    // no ID: unpin it and pin the running window again (README).
    const string AppId = "FO4Lightbox.Viewer";
    static readonly Guid AppModelKeys = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");   // PKEY_AppUserModel_*
    const uint KeyRelaunchCommand = 2, KeyRelaunchIcon = 3, KeyRelaunchName = 4, KeyId = 5;

    // every top-level window of the browser process the launcher started; if that process handed the window to a
    // browser that was already running on the profile, the window still showing the page's first title
    static void StampWindows(Process browser)
    {
        uint pid = 0;
        try { if (!browser.HasExited) pid = (uint)browser.Id; } catch (Exception) { }
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;     // (GW_OWNER: menus, popups)
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (pid != 0 ? p == pid : WindowText(h) == Title) Stamp(h);
            return true;
        }, IntPtr.Zero);
    }

    static string WindowText(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // idempotent: a window that already has the ID is left alone (setting it again would make the taskbar redo it)
    static void Stamp(IntPtr hwnd)
    {
        IPropertyStore store = null;
        try
        {
            Guid iid = typeof(IPropertyStore).GUID;
            if (SHGetPropertyStoreForWindow(hwnd, ref iid, out store) != 0 || store == null) return;
            if (ReadString(store, KeyId) == AppId) return;
            string exe = Application.ExecutablePath;
            // the relaunch properties first, the ID last: the taskbar reads them when the ID changes
            WriteString(store, KeyRelaunchCommand, Quote(exe));
            WriteString(store, KeyRelaunchName, Title);
            WriteString(store, KeyRelaunchIcon, exe + ",0");
            WriteString(store, KeyId, AppId);
            store.Commit();
        }
        catch (Exception) { }
        finally { if (store != null) Marshal.ReleaseComObject(store); }
    }

    static string ReadString(IPropertyStore store, uint pid)
    {
        PropertyKey k = new PropertyKey { fmtid = AppModelKeys, pid = pid };
        PropVariant v;
        if (store.GetValue(ref k, out v) != 0) return null;
        try { return v.vt == 31 ? Marshal.PtrToStringUni(v.p) : null; }       // VT_LPWSTR
        finally { PropVariantClear(ref v); }
    }

    static void WriteString(IPropertyStore store, uint pid, string value)
    {
        PropertyKey k = new PropertyKey { fmtid = AppModelKeys, pid = pid };
        PropVariant v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(value) };
        try { store.SetValue(ref k, ref v); }
        finally { PropVariantClear(ref v); }                                    // (frees the string)
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Explicit, Size = 24)]                              // a PROPVARIANT holding a pointer
    struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

    [DllImport("shell32.dll")]
    static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant v);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);

    static bool IsLightbox(int port)
    {
        if (PortFree(port)) return false;                   // nothing listens there
        string v = Get(port, "/api/version");
        return v != null && v.Contains("\"boot\"");
    }

    static bool PortFree(int port)
    {
        try
        {
            TcpListener l = new TcpListener(IPAddress.Loopback, port);
            l.ExclusiveAddressUse = true;
            l.Start();
            l.Stop();
            return true;
        }
        catch (Exception) { return false; }
    }

    static int FreePort(int from)
    {
        for (int p = from; p < from + 50; p++) if (PortFree(p)) return p;
        return from;
    }

    // ------------------------------------------------------------------------------------------- the window
    static Process OpenWindow(string url)
    {
        string browser = FindBrowser();
        if (browser == null) return null;
        string profile = Path.Combine(home, "browser");
        profileDir = profile;
        // --disk-cache-size: the profile's cache keeps every texture and scene the viewer was sent; without a cap Edge
        // lets it grow to several GB (a 1.3.0 report: 5 GB and growing). 512 MB; a bigger one is trimmed at start
        string a = "--app=" + url + " --user-data-dir=" + Quote(profile) + " --start-maximized --no-first-run"
                   + " --no-default-browser-check --disable-sync --disable-features=msImplicitSignin,msEdgeWelcomePage"
                   + " --disk-cache-size=536870912";
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(browser, a);
            psi.UseShellExecute = false;
            return Process.Start(psi);
        }
        catch (Exception) { return null; }
    }

    static string FindBrowser()
    {
        foreach (string name in new string[] { "msedge.exe", "chrome.exe" })
        {
            foreach (RegistryKey hive in new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                try
                {
                    using (RegistryKey k = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + name))
                    {
                        string p = k == null ? null : k.GetValue(null) as string;
                        if (!string.IsNullOrEmpty(p) && File.Exists(p.Trim('"'))) return p.Trim('"');
                    }
                }
                catch (Exception) { }
            }
        }
        string[] guesses = {
            Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "", @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles") ?? "", @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles") ?? "", @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (string g in guesses) if (File.Exists(g)) return g;
        return null;
    }

    // ------------------------------------------------------------------------------------------- the game folder
    static string GameFile() { return Path.Combine(home, "game_path.txt"); }

    static string SavedGame()
    {
        try
        {
            string g = File.ReadAllText(GameFile()).Trim();
            return File.Exists(Path.Combine(g, "Data", "Fallout4.esm")) ? g : null;
        }
        catch (Exception) { return null; }
    }

    static string AskGame(string current)
    {
        while (true)
        {
            using (FolderBrowserDialog d = new FolderBrowserDialog())
            {
                d.Description = "FO4 Lightbox could not find Fallout 4. Pick your Fallout 4 folder (the one that holds Data).";
                d.ShowNewFolderButton = false;
                if (!string.IsNullOrEmpty(current) && Directory.Exists(current)) d.SelectedPath = current;
                if (d.ShowDialog() != DialogResult.OK) return null;
                string g = d.SelectedPath.TrimEnd('\\');
                if (Path.GetFileName(g).Equals("Data", StringComparison.OrdinalIgnoreCase)) g = Path.GetDirectoryName(g);
                if (File.Exists(Path.Combine(g, "Data", "Fallout4.esm")))
                {
                    try { File.WriteAllText(GameFile(), g); } catch (Exception) { }
                    return g;
                }
                MessageBox.Show("There is no Data\\Fallout4.esm in\n" + g + "\n\nPick the folder Fallout4.exe is in.",
                                Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                current = g;
            }
        }
    }

    // ------------------------------------------------------------------------------------------- helpers
    static string FindOnPath(string exe)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            try
            {
                string p = Path.Combine(dir.Trim().Trim('"'), exe);
                if (dir.Trim().Length > 0 && File.Exists(p) && !p.ToLowerInvariant().Contains(@"\windowsapps\")) return p;
            }
            catch (Exception) { }
        }
        string win = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), exe);
        return File.Exists(win) ? win : null;
    }

    static string Quote(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return s;
        StringBuilder b = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in s)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); slashes = 0; continue; }
            b.Append('\\', slashes); slashes = 0; b.Append(c);
        }
        b.Append('\\', slashes * 2);
        return b.Append('"').ToString();
    }

    static string LastLines(string text, int n)
    {
        string[] lines = text.Replace("\r", "").TrimEnd('\n').Split('\n');
        int start = Math.Max(0, lines.Length - n);
        return string.Join("\n", lines, start, lines.Length - start);
    }

    static void Fail(string message)
    {
        if (ui != null) ui.SetVisible(false);
        MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

// The splash: the artwork with soft rounded corners and its shadow (a per-pixel-alpha layered window), the live status
// line, the version and an animated progress bar. Thread-safe Set() / SetVisible() / Done() for the worker.
class SplashWindow : Form
{
    // where the live parts go, in the artwork's CSS pixels (launcher/splash/splash.html: an 800 x 500 page, the card at
    // 40,40 of 720 x 420; the strip between the separator line and the credits is left empty for them)
    const float PageW = 800f, PageH = 500f;
    const float BarX = 86f, BarY = 421f, BarW = 628f, BarH = 4f;
    const float TextX = 86f, TextY = 394.5f, VersionRight = 714f, TextPx = 12.5f;

    readonly Bitmap art;                       // the artwork at window size
    readonly float k;                          // window pixels per CSS pixel
    readonly string version;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly object gate = new object();
    Bitmap frame;
    double target, shown, lastTick, targetSince;
    string status = "", prevStatus = "";
    double statusAt = -1;
    double fade;                               // 0..1 window opacity
    bool done, hidden;

    public SplashWindow(string version)
    {
        this.version = version;
        Text = "FO4 Lightbox";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        Cursor = Cursors.AppStarting;
        using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) k = g.DpiX / 96f;
        Size = new Size((int)Math.Round(PageW * k), (int)Math.Round(PageH * k));
        Rectangle wa = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(wa.X + (wa.Width - Width) / 2, wa.Y + (wa.Height - Height) / 2);
        try
        {
            using (Stream st = Assembly.GetExecutingAssembly().GetManifestResourceStream("lightbox.ico")) Icon = new Icon(st);
        }
        catch (Exception) { }
        art = new Bitmap(Width, Height, PixelFormat.Format32bppPArgb);
        try
        {
            using (Stream st = Assembly.GetExecutingAssembly().GetManifestResourceStream("splash.png"))
            using (Bitmap src = new Bitmap(st))
            using (Graphics g = Graphics.FromImage(art))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingMode = CompositingMode.SourceCopy;
                g.DrawImage(src, new Rectangle(0, 0, Width, Height));
            }
        }
        catch (Exception) { }
        frame = new Bitmap(Width, Height, PixelFormat.Format32bppPArgb);
        timer.Interval = 15;
        timer.Tick += delegate { Tick(); };
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x00080000;          // WS_EX_LAYERED: drawn with UpdateLayeredWindow, per-pixel alpha
            return cp;
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Render();
        timer.Start();
    }

    // ---- called from the worker thread
    public void Set(double progress, string text)
    {
        lock (gate)
        {
            if (progress > target) { target = Math.Min(1, progress); targetSince = clock.Elapsed.TotalSeconds; }
            if (text != null && text != status)
            {
                prevStatus = status; status = text; statusAt = clock.Elapsed.TotalSeconds;
            }
        }
    }

    public void SetVisible(bool on)
    {
        lock (gate) hidden = !on;
    }

    public void Done()
    {
        lock (gate) done = true;
    }

    // ---- UI thread
    void Tick()
    {
        double now = clock.Elapsed.TotalSeconds, dt = Math.Min(0.1, now - lastTick);
        lastTick = now;
        bool isDone, isHidden;
        double goal;
        lock (gate)
        {
            isDone = done; isHidden = hidden;
            // between steps the bar keeps creeping a little toward the next one, so it never looks stuck
            double creep = 0.06 * (1 - Math.Exp(-(now - targetSince) / 2.5));
            goal = isDone ? 1 : Math.Min(0.99, target + (target < 1 ? creep : 0));
        }
        shown += (goal - shown) * (1 - Math.Exp(-dt * (isDone ? 14 : 5)));
        if (Visible == isHidden) Visible = !isHidden;
        if (isDone && shown > 0.985) fade -= dt / 0.28;       // complete: fade out
        else fade = Math.Min(1, fade + dt / 0.22);            // fade in
        if (fade <= 0)
        {
            timer.Stop();
            Close();
            return;
        }
        Render();
    }

    void Render()
    {
        if (!IsHandleCreated) return;
        Compose(clock.Elapsed.TotalSeconds);
        Push();
    }

    // a frame as a PNG without showing the window (launcher check: FO4 Lightbox.exe --render-splash out.png 0.6 "text")
    public void Snapshot(string path, double progress, string text, double at)
    {
        lock (gate) { status = text; prevStatus = ""; statusAt = -10; }
        shown = progress;
        Compose(at);
        frame.Save(path, ImageFormat.Png);
    }

    void Compose(double now)
    {
        string st, prev;
        double since;
        lock (gate) { st = status; prev = prevStatus; since = now - statusAt; }
        using (Graphics g = Graphics.FromImage(frame))
        {
            g.CompositingMode = CompositingMode.SourceCopy;
            g.DrawImageUnscaled(art, 0, 0);
            g.CompositingMode = CompositingMode.SourceOver;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

            // status: the old line fades out sliding up, then the new one fades in from below
            using (Font f = new Font("Segoe UI", TextPx * k, FontStyle.Regular, GraphicsUnit.Pixel))
            {
                const double half = 0.14;
                if (since < half && prev.Length > 0)
                {
                    double u = Ease(since / half);
                    DrawText(g, prev, f, Color.FromArgb((int)(210 * (1 - u)), 214, 220, 228), TextX, false, (float)(-5 * u) * k);
                }
                else
                {
                    double u = Ease(Math.Min(1, (since - (prev.Length > 0 ? half : 0)) / (half * 1.6)));
                    DrawText(g, st, f, Color.FromArgb((int)(210 * u), 214, 220, 228), TextX, false, (float)(5 * (1 - u)) * k);
                }
            }
            using (Font f = new Font("Segoe UI", 11.5f * k, FontStyle.Regular, GraphicsUnit.Pixel))
                DrawText(g, version.Length > 0 ? "Version " + version : "", f, Color.FromArgb(150, 128, 138, 150), VersionRight, true, 0);

            DrawBar(g, now);
        }
    }

    static double Ease(double t) { t = Math.Max(0, Math.Min(1, t)); return 1 - Math.Pow(1 - t, 3); }

    void DrawText(Graphics g, string s, Font f, Color c, float x, bool rightAligned, float dy)
    {
        if (s.Length == 0 || c.A == 0) return;
        using (SolidBrush b = new SolidBrush(c))
        using (StringFormat sf = new StringFormat(StringFormat.GenericTypographic))
        {
            sf.Alignment = rightAligned ? StringAlignment.Far : StringAlignment.Near;
            sf.FormatFlags |= StringFormatFlags.NoWrap | StringFormatFlags.MeasureTrailingSpaces;
            float y = TextY * k + (TextPx * k - f.Size) * 0.5f + dy;
            if (rightAligned) g.DrawString(s, f, b, new RectangleF(0, y, x * k, f.Size * 1.6f), sf);
            else g.DrawString(s, f, b, new PointF(x * k, y), sf);
        }
    }

    void DrawBar(Graphics g, double now)
    {
        RectangleF bar = new RectangleF(BarX * k, BarY * k, BarW * k, BarH * k);
        float r = bar.Height / 2;
        using (GraphicsPath track = Rounded(bar, r))
        using (SolidBrush tb = new SolidBrush(Color.FromArgb(26, 255, 255, 255)))
            g.FillPath(tb, track);
        float w = (float)Math.Max(bar.Height, bar.Width * Math.Max(0, Math.Min(1, shown)));
        RectangleF fill = new RectangleF(bar.X, bar.Y, w, bar.Height);

        // glow under the filled part
        for (int i = 4; i >= 1; i--)
        {
            RectangleF gl = fill;
            gl.Inflate(i * 1.7f * k, i * 1.5f * k);
            using (GraphicsPath p = Rounded(gl, gl.Height / 2))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(9, 240, 175, 80)))
                g.FillPath(b, p);
        }
        using (GraphicsPath fp = Rounded(fill, r))
        {
            using (LinearGradientBrush lb = new LinearGradientBrush(new PointF(bar.X - 1, 0), new PointF(bar.Right + 1, 0),
                                                                    Color.FromArgb(255, 196, 128, 40), Color.FromArgb(255, 255, 222, 150)))
                g.FillPath(lb, fp);
            // a soft highlight sweeping along the bar
            float period = 1.9f, span = 120 * k;
            float sx = fill.X - span + (float)((now % period) / period) * (fill.Width + 2 * span);
            Region old = g.Clip;
            g.SetClip(fp, CombineMode.Intersect);
            using (LinearGradientBrush sb = new LinearGradientBrush(new PointF(sx - span / 2, 0), new PointF(sx + span / 2, 0),
                                                                    Color.FromArgb(0, 255, 255, 255), Color.FromArgb(0, 255, 255, 255)))
            {
                ColorBlend cb = new ColorBlend(3);
                cb.Colors = new Color[] { Color.FromArgb(0, 255, 250, 235), Color.FromArgb(150, 255, 250, 235), Color.FromArgb(0, 255, 250, 235) };
                cb.Positions = new float[] { 0f, 0.5f, 1f };
                sb.InterpolationColors = cb;
                g.FillRectangle(sb, sx - span / 2, fill.Y, span, fill.Height);
            }
            g.Clip = old;
        }
        // the bright head of the bar
        float hx = fill.Right - r, hy = fill.Y + r, hr = 9 * k;
        using (GraphicsPath hp = new GraphicsPath())
        {
            hp.AddEllipse(hx - hr, hy - hr, hr * 2, hr * 2);
            using (PathGradientBrush pb = new PathGradientBrush(hp))
            {
                pb.CenterColor = Color.FromArgb(120, 255, 236, 190);
                pb.SurroundColors = new Color[] { Color.FromArgb(0, 255, 200, 120) };
                g.FillPath(pb, hp);
            }
        }
    }

    static GraphicsPath Rounded(RectangleF r, float radius)
    {
        GraphicsPath p = new GraphicsPath();
        float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        if (d <= 0.5f) { p.AddRectangle(r); return p; }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    // ---- UpdateLayeredWindow: the frame with its alpha, at the current fade
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; public POINT(int x, int y) { this.x = x; this.y = y; } }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; public SIZE(int x, int y) { cx = x; cy = y; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLENDFUNCTION { public byte op, flags, alpha, format; }
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc,
                                           ref POINT pprSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObject);

    void Push()
    {
        IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen), hbmp = IntPtr.Zero, old = IntPtr.Zero;
        try
        {
            hbmp = frame.GetHbitmap(Color.FromArgb(0));
            old = SelectObject(mem, hbmp);
            SIZE size = new SIZE(frame.Width, frame.Height);
            POINT src = new POINT(0, 0), dst = new POINT(Left, Top);
            BLENDFUNCTION bf = new BLENDFUNCTION();
            bf.op = 0; bf.flags = 0; bf.format = 1;          // AC_SRC_OVER, AC_SRC_ALPHA
            double e = Math.Max(0, Math.Min(1, fade));
            bf.alpha = (byte)(255 * e * e * (3 - 2 * e));    // smoothstep fade
            UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref bf, 2 /*ULW_ALPHA*/);
        }
        finally
        {
            if (hbmp != IntPtr.Zero) { SelectObject(mem, old); DeleteObject(hbmp); }
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }
}
