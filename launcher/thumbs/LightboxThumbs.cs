// FO4 Lightbox: Explorer thumbnails for .nif files (IThumbnailProvider + IInitializeWithStream), loaded by Windows'
// thumbnail process. Explorer hands over the file's bytes; they go to Lightbox's thumbnail service (server\app.py
// --thumbs: a hidden server and headless browser that draw the mesh with the viewer's own renderer), which answers a PNG
// with a transparent background. The service is started here when it isn't running and stops by itself when idle.
// Registered by server\thumbreg.py (File > Show .nif thumbnails in Explorer). C# 5: built by the csc.exe in Windows.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;
using ComIStream = System.Runtime.InteropServices.ComTypes.IStream;
using STATSTG = System.Runtime.InteropServices.ComTypes.STATSTG;

[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]          // the COM registration names it: keep it
[assembly: System.Reflection.AssemblyTitle("FO4 Lightbox .nif thumbnails for Explorer")]
[assembly: System.Reflection.AssemblyProduct("FO4 Lightbox")]

namespace FO4Lightbox.Thumbs
{
    [ComImport, Guid("b824b49d-22ac-4161-ac8a-9916e8fa3f7f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IInitializeWithStream
    {
        [PreserveSig] int Initialize(ComIStream stream, uint grfMode);
    }

    [ComImport, Guid("e357fccd-a995-4576-b01f-234630154e96"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IThumbnailProvider
    {
        [PreserveSig] int GetThumbnail(uint cx, out IntPtr phbmp, out uint pdwAlpha);
    }

    [ComVisible(true), Guid(Provider.ClsId), ClassInterface(ClassInterfaceType.None), ProgId("FO4Lightbox.NifThumbnail")]
    public sealed class Provider : IInitializeWithStream, IThumbnailProvider
    {
        public const string ClsId = "04c52f43-6c03-495c-ad2e-75f1d570b40a";
        const int S_OK = 0, E_FAIL = unchecked((int)0x80004005), E_UNEXPECTED = unchecked((int)0x8000FFFF);
        const uint WTSAT_ARGB = 2;
        const long MaxBytes = 256L << 20;              // bigger files keep their icon

        byte[] data;
        string name = "thumbnail.nif";

        public int Initialize(ComIStream s, uint grfMode)
        {
            if (data != null) return E_UNEXPECTED;
            try
            {
                STATSTG st;
                s.Stat(out st, 0);                      // STATFLAG_DEFAULT: with the file's name
                if (!string.IsNullOrEmpty(st.pwcsName)) name = Path.GetFileName(st.pwcsName);
                if (st.cbSize > MaxBytes) return E_FAIL;
                data = new byte[st.cbSize];
                IntPtr got = Marshal.AllocCoTaskMem(4);
                try
                {
                    int off = 0;
                    while (off < data.Length)
                    {
                        int n = Math.Min(1 << 20, data.Length - off);
                        byte[] buf = off == 0 && n == data.Length ? data : new byte[n];
                        s.Read(buf, n, got);
                        int k = Marshal.ReadInt32(got);
                        if (k <= 0) break;
                        if (buf != data) Buffer.BlockCopy(buf, 0, data, off, k);
                        off += k;
                    }
                    if (off != data.Length) { data = null; return E_FAIL; }
                }
                finally { Marshal.FreeCoTaskMem(got); }
                return S_OK;
            }
            catch { data = null; return E_FAIL; }
            finally { Marshal.ReleaseComObject(s); }
        }

        public int GetThumbnail(uint cx, out IntPtr phbmp, out uint pdwAlpha)
        {
            phbmp = IntPtr.Zero; pdwAlpha = WTSAT_ARGB;
            if (data == null) return E_UNEXPECTED;
            try
            {
                byte[] png = Service.Render(data, name, (int)Math.Max(16, Math.Min(1024, cx)));
                if (png == null) return E_FAIL;
                phbmp = ToHBitmap(png);
                return phbmp == IntPtr.Zero ? E_FAIL : S_OK;
            }
            catch (Exception e)
            {
                Service.Log(name + ": " + e.Message);
                return E_FAIL;
            }
            finally { data = null; }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct BITMAPINFOHEADER
        {
            public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount;
            public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant;
        }

        [DllImport("gdi32.dll")]
        static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);

        // a 32-bit top-down DIB with straight (not premultiplied) alpha, as Windows' thumbnail cache takes it
        static IntPtr ToHBitmap(byte[] png)
        {
            using (var ms = new MemoryStream(png))
            using (var bmp = new Bitmap(ms))
            {
                int w = bmp.Width, h = bmp.Height;
                var bi = new BITMAPINFOHEADER { biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER)), biWidth = w,
                                                biHeight = -h, biPlanes = 1, biBitCount = 32 };
                IntPtr bits;
                IntPtr hbmp = CreateDIBSection(IntPtr.Zero, ref bi, 0, out bits, IntPtr.Zero, 0);
                if (hbmp == IntPtr.Zero || bits == IntPtr.Zero) return IntPtr.Zero;
                BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    byte[] row = new byte[w * 4];
                    for (int y = 0; y < h; y++)
                    {
                        Marshal.Copy(new IntPtr(d.Scan0.ToInt64() + (long)y * d.Stride), row, 0, row.Length);
                        Marshal.Copy(row, 0, new IntPtr(bits.ToInt64() + (long)y * w * 4), row.Length);
                    }
                }
                finally { bmp.UnlockBits(d); }
                return hbmp;
            }
        }
    }

    // The thumbnail service: found by the port file it writes (thumbs.port: "port pid"), started when it isn't running.
    public static class Service
    {
        static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FO4 Lightbox");
        static readonly string PortFile = Path.Combine(Dir, "thumbs.port");
        static readonly object logLock = new object();

        static Service()
        {
            ServicePointManager.Expect100Continue = false;          // (the server answers HTTP/1.0)
            if (ServicePointManager.DefaultConnectionLimit < 8) ServicePointManager.DefaultConnectionLimit = 8;
        }

        public static byte[] Render(byte[] nif, string name, int size)
        {
            int port = RunningPort();
            if (port > 0)
            {
                try { return Post(port, nif, name, size); }
                catch (WebException e)
                {
                    if (e.Status != WebExceptionStatus.ConnectFailure) throw;          // (a 422: not something to draw)
                }
            }
            port = Start();
            return Post(port, nif, name, size);
        }

        static byte[] Post(int port, byte[] nif, string name, int size)
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/thumb?size=" + size +
                                                        "&name=" + Uri.EscapeDataString(name));
            req.Method = "POST";
            req.Proxy = null;
            req.ContentType = "application/octet-stream";
            req.ContentLength = nif.Length;
            req.Timeout = req.ReadWriteTimeout = 90000;
            using (Stream s = req.GetRequestStream()) s.Write(nif, 0, nif.Length);
            using (var r = (HttpWebResponse)req.GetResponse())
            using (Stream rs = r.GetResponseStream())
            using (var ms = new MemoryStream())
            {
                rs.CopyTo(ms);
                return ms.ToArray();
            }
        }

        // the port of a running service, or 0
        static int RunningPort()
        {
            try
            {
                string[] f = File.ReadAllText(PortFile).Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                int port = int.Parse(f[0]), pid = int.Parse(f[1]);
                using (Process p = Process.GetProcessById(pid)) if (p.HasExited) return 0;
                return port;
            }
            catch { return 0; }
        }

        static bool Answers(int port)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/version");
                req.Proxy = null; req.Timeout = 5000;
                using (req.GetResponse()) return true;
            }
            catch { return false; }
        }

        static DateTime failedAt = DateTime.MinValue;

        // One start at a time (Explorer asks for many thumbnails at once, from several threads and processes). After
        // a start that failed (no game found, Lightbox moved), the next minute's thumbnails don't try again.
        static int Start()
        {
            if ((DateTime.UtcNow - failedAt).TotalSeconds < 60) throw new InvalidOperationException("the service failed to start a moment ago");
            try { return StartOnce(); }
            catch { failedAt = DateTime.UtcNow; throw; }
        }

        static int StartOnce()
        {
            using (var m = new Mutex(false, @"Local\FO4LightboxThumbService"))
            {
                try { m.WaitOne(90000); } catch (AbandonedMutexException) { }
                try
                {
                    int port = RunningPort();
                    if (port > 0 && Answers(port)) return port;
                    // thumbs.paths (python, app.py) first: a Store / install-manager Python can't write the registry
                    // for other programs to see; the registry values are the fallback
                    string python = null, app = null;
                    try
                    {
                        string[] f = File.ReadAllLines(Path.Combine(Dir, "thumbs.paths"));
                        if (f.Length >= 2) { python = f[0].Trim(); app = f[1].Trim(); }
                    }
                    catch { }
                    if (string.IsNullOrEmpty(python) || !File.Exists(python) || string.IsNullOrEmpty(app) || !File.Exists(app))
                        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\FO4 Lightbox"))
                        {
                            python = k == null ? null : k.GetValue("ThumbsPython") as string;
                            app = k == null ? null : k.GetValue("ThumbsApp") as string;
                        }
                    if (string.IsNullOrEmpty(python) || !File.Exists(python) || string.IsNullOrEmpty(app) || !File.Exists(app))
                        throw new InvalidOperationException("FO4 Lightbox not found: start it once and turn Explorer thumbnails on again");
                    // through the shell: the service inherits none of this process's handles (a console pipe of the
                    // caller would otherwise stay open as long as the service runs)
                    var psi = new ProcessStartInfo(python, "-X utf8 -u \"" + app + "\" --thumbs")
                    {
                        UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden,
                        WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(app))
                    };
                    using (Process p = Process.Start(psi))
                    {
                        var clock = Stopwatch.StartNew();
                        // it writes thumbs.port once it serves; one that finds another service running ends at once
                        // (that one's port is then in the file)
                        while (clock.ElapsedMilliseconds < 60000)
                        {
                            Thread.Sleep(150);
                            bool ended = p.HasExited;
                            port = RunningPort();
                            if (port > 0 && Answers(port)) return port;
                            if (ended) throw new InvalidOperationException("the thumbnail service stopped (see " + Path.Combine(Dir, "thumbs.log") + ")");
                        }
                    }
                    throw new TimeoutException("the thumbnail service did not start");
                }
                finally { m.ReleaseMutex(); }
            }
        }

        public static void Log(string line)
        {
            try
            {
                lock (logLock)
                {
                    string p = Path.Combine(Dir, "thumbs-explorer.log");
                    if (File.Exists(p) && new FileInfo(p).Length > 256 * 1024) File.Delete(p);
                    File.AppendAllText(p, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine);
                }
            }
            catch { }
        }
    }
}
