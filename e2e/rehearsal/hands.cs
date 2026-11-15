// The eyes and hands of the person in a rehearsal run: what a person's eyes and hands can do on
// the screen, and nothing more. Coordinates are those of the picture `look` saves (1600 by 860,
// the screen above the taskbar at 0.625 of its size). Every click, drag, key and piece of typing
// goes only to the rehearsal's own windows (the terminal and the browser): the window under the
// point, or the window that has the keyboard, must belong to a process named in the allowed file,
// or the action is refused. Every action is written to the log.
//
//   hands look <file.png>              the whole screen the person may use
//   hands zoom <x> <y> <w> <h> <file>  a part of it at full size, to read small writing
//   hands click <x> <y>                hands dblclick <x> <y>        hands rightclick <x> <y>
//   hands drag <x1> <y1> <x2> <y2>     press, move smoothly, let go
//   hands draw <x1> <y1> <x2> <y2> [<x3> <y3> ...]   one stroke through every point, as a pen draws
//   hands scroll <x> <y> <clicks>      positive scrolls down
//   hands type <text>                  hands key <name>  (enter, tab, esc, up, down, left, right,
//                                      backspace, delete, home, end, pageup, pagedown, space,
//                                      ctrl+c, ctrl+v, ctrl+a, ctrl+l, shift+tab)
//   hands wait <seconds>
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

static class Hands {
  const int W = 2560, H = 1376, PW = 1600, PH = 860;
  const double S = 1.6;
  static string Dir = Environment.GetEnvironmentVariable("IT_HANDS_DIR") ?? @"D:\it-rehearsal\work\hands";

  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  static void Log(string s) {
    try { File.AppendAllText(Path.Combine(Dir, "hands.log"), DateTime.UtcNow.ToString("o") + " " + s + Environment.NewLine); } catch { }
  }
  static HashSet<uint> Allowed() {
    var set = new HashSet<uint>();
    try { foreach (var l in File.ReadAllLines(Path.Combine(Dir, "allowed.txt"))) { uint p; if (uint.TryParse(l.Trim(), out p)) set.Add(p); } } catch { }
    return set;
  }
  static uint PidAt(int x, int y) {
    var h = GetAncestor(WindowFromPoint(new POINT { X = x, Y = y }), 2);
    uint pid; GetWindowThreadProcessId(h, out pid); return pid;
  }
  static uint PidFront() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }
  static void Fail(string why) { Console.WriteLine("refused: " + why); Log("refused " + why); Environment.Exit(2); }
  static int[] P(string x, string y) {
    double fx = double.Parse(x, System.Globalization.CultureInfo.InvariantCulture), fy = double.Parse(y, System.Globalization.CultureInfo.InvariantCulture);
    if (fx < 0 || fy < 0 || fx >= PW || fy >= PH) Fail("the point " + x + "," + y + " is outside the screen (0-1599, 0-859)");
    return new[] { (int)Math.Round(fx * S), (int)Math.Round(fy * S) };
  }
  static void Check(int[] p) {
    // The windows' own title bars (move, minimise, close) are not the person's to use
    if (p[1] < 34) Fail("that is the window's own frame; the windows stay where they are");
    if (!Allowed().Contains(PidAt(p[0], p[1]))) Fail("there is nothing of the terminal or the browser at that point");
  }
  static void CheckFront() {
    if (!Allowed().Contains(PidFront())) Fail("neither the terminal nor the browser has the keyboard; click in one of them first");
  }
  static void Move(int x, int y) { SetCursorPos(x, y); Thread.Sleep(12); }
  const uint LD = 0x02, LU = 0x04, RD = 0x08, RU = 0x10, WHEEL = 0x800;
  static void Glide(int[] a, int[] b, int steps) {
    for (int i = 1; i <= steps; i++) { Move(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps); Thread.Sleep(10); }
  }
  static void Key(byte vk, bool up) { keybd_event(vk, 0, up ? 2u : 0u, UIntPtr.Zero); }
  static void Unicode(char c) {
    var inputs = new INPUT[2];
    inputs[0].type = 1; inputs[0].u.ki = new KEYBDINPUT { wScan = c, dwFlags = 0x4 };
    inputs[1].type = 1; inputs[1].u.ki = new KEYBDINPUT { wScan = c, dwFlags = 0x4 | 0x2 };
    SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
  static readonly Dictionary<string, byte> Keys = new Dictionary<string, byte> {
    {"enter",0x0D},{"tab",0x09},{"esc",0x1B},{"escape",0x1B},{"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},
    {"backspace",0x08},{"delete",0x2E},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},{"space",0x20},
  };

  static int Main(string[] a) {
    SetProcessDPIAware();
    Directory.CreateDirectory(Dir);
    if (a.Length == 0) { Console.WriteLine("hands look|zoom|click|dblclick|rightclick|drag|draw|scroll|type|key|wait ..."); return 1; }
    string cmd = a[0].ToLowerInvariant();
    Log(cmd + " " + (cmd == "type" ? "(" + string.Join(" ", a.Skip(1)).Length + " characters)" : string.Join(" ", a.Skip(1))));
    switch (cmd) {
      case "look": case "zoom": {
        var shot = new Bitmap(W, H, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(0, 0, 0, 0, new Size(W, H));
        Bitmap outp;
        string file;
        if (cmd == "look") {
          file = a[1];
          outp = new Bitmap(PW, PH);
          using (var g = Graphics.FromImage(outp)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(shot, 0, 0, PW, PH); }
        } else {
          var p = P(a[1], a[2]); int w = (int)(double.Parse(a[3]) * S), h = (int)(double.Parse(a[4]) * S); file = a[5];
          w = Math.Max(16, Math.Min(w, W - p[0])); h = Math.Max(16, Math.Min(h, H - p[1]));
          outp = shot.Clone(new Rectangle(p[0], p[1], w, h), shot.PixelFormat);
        }
        outp.Save(file, ImageFormat.Png);
        Console.WriteLine("saved " + file);
        return 0;
      }
      case "click": case "dblclick": case "rightclick": {
        var p = P(a[1], a[2]); Check(p); Move(p[0], p[1]); Thread.Sleep(60);
        int n = cmd == "dblclick" ? 2 : 1;
        for (int i = 0; i < n; i++) {
          mouse_event(cmd == "rightclick" ? RD : LD, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(40);
          mouse_event(cmd == "rightclick" ? RU : LU, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(70);
        }
        Console.WriteLine("done"); return 0;
      }
      case "drag": case "draw": {
        var pts = new List<int[]>();
        for (int i = 1; i + 1 < a.Length; i += 2) pts.Add(P(a[i], a[i + 1]));
        if (pts.Count < 2) Fail("give at least two points");
        foreach (var p in pts) Check(p);
        Move(pts[0][0], pts[0][1]); Thread.Sleep(80);
        mouse_event(LD, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(cmd == "drag" ? 150 : 40);
        for (int i = 1; i < pts.Count; i++) Glide(pts[i - 1], pts[i], cmd == "drag" ? 30 : 8);
        Thread.Sleep(cmd == "drag" ? 150 : 30);
        mouse_event(LU, 0, 0, 0, UIntPtr.Zero);
        Console.WriteLine("done"); return 0;
      }
      case "scroll": {
        var p = P(a[1], a[2]); Check(p); Move(p[0], p[1]);
        int clicks = int.Parse(a[3]);
        for (int i = 0; i < Math.Abs(clicks); i++) { mouse_event(WHEEL, 0, 0, clicks > 0 ? -120 : 120, UIntPtr.Zero); Thread.Sleep(40); }
        Console.WriteLine("done"); return 0;
      }
      case "type": {
        CheckFront();
        string text = string.Join(" ", a.Skip(1));
        foreach (char c in text) { if (c == '\n') { Key(0x0D, false); Key(0x0D, true); } else Unicode(c); Thread.Sleep(18); }
        Console.WriteLine("typed " + text.Length + " characters"); return 0;
      }
      case "key": {
        CheckFront();
        string k = a[1].ToLowerInvariant();
        byte mod = 0; string name = k;
        if (k.StartsWith("ctrl+")) { mod = 0x11; name = k.Substring(5); }
        else if (k.StartsWith("shift+")) { mod = 0x10; name = k.Substring(6); }
        byte vk;
        if (!Keys.TryGetValue(name, out vk)) {
          if (mod == 0x11 && name.Length == 1 && "cval".Contains(name)) vk = (byte)char.ToUpperInvariant(name[0]);
          else Fail("that key is not one a person here would press");
        }
        if (mod != 0) Key(mod, false);
        Key(vk, false); Thread.Sleep(30); Key(vk, true);
        if (mod != 0) Key(mod, true);
        Console.WriteLine("pressed " + k); return 0;
      }
      case "raise": {
        // For the harness, not the person: every visible top-level window of the allowed processes
        // is put on top of all others and kept there, so that nothing else is on the screen
        var allowed = Allowed();
        int n = 0;
        EnumWindows((h, l) => {
          uint pid; GetWindowThreadProcessId(h, out pid);
          if (allowed.Contains(pid) && IsWindowVisible(h)) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); n++; }
          return true;
        }, IntPtr.Zero);
        Console.WriteLine("raised " + n); return 0;
      }
      case "windows": {
        // For the harness: where the visible top-level windows are, which are the rehearsal's, and
        // which are kept on top. Only the rehearsal's own windows are named
        var allowed = Allowed();
        EnumWindows((h, l) => {
          if (!IsWindowVisible(h)) return true;
          uint pid; GetWindowThreadProcessId(h, out pid);
          RECT r; GetWindowRect(h, out r);
          if (r.R - r.L < 50 || r.B - r.T < 50) return true;
          long ex = GetWindowLongPtr(h, -20).ToInt64();
          var sb = new System.Text.StringBuilder(200);
          if (allowed.Contains(pid)) GetWindowText(h, sb, 200);
          Console.WriteLine((allowed.Contains(pid) ? "MINE  " : "other ") + "pid " + pid + " rect " + r.L + "," + r.T + "," + r.R + "," + r.B + ((ex & 0x8) != 0 ? " topmost" : "") + (IsIconic(h) ? " minimized" : "") + (allowed.Contains(pid) ? " \"" + sb + "\"" : ""));
          return true;
        }, IntPtr.Zero);
        return 0;
      }
      case "front": {
        // For the harness: brings the rehearsal's windows to the front and gives the first the keyboard
        var allowed = Allowed();
        IntPtr first = IntPtr.Zero;
        EnumWindows((h, l) => {
          uint pid; GetWindowThreadProcessId(h, out pid);
          if (allowed.Contains(pid) && IsWindowVisible(h)) { ShowWindow(h, 9); SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002); BringWindowToTop(h); if (first == IntPtr.Zero) first = h; }
          return true;
        }, IntPtr.Zero);
        if (first != IntPtr.Zero) SetForegroundWindow(first);
        Console.WriteLine("done"); return 0;
      }
      case "unraise": {
        var allowed = Allowed();
        EnumWindows((h, l) => {
          uint pid; GetWindowThreadProcessId(h, out pid);
          if (allowed.Contains(pid)) SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
          return true;
        }, IntPtr.Zero);
        Console.WriteLine("done"); return 0;
      }
      case "browse": {
        // Typing an address into the browser's address bar and pressing Enter
        string url = string.Join("", a.Skip(1)).Trim();
        if (!(url.StartsWith("http://") || url.StartsWith("https://"))) Fail("an address begins with http:// or https://");
        File.WriteAllText(Path.Combine(Dir, "browse.txt"), url);
        for (int i = 0; i < 100 && File.Exists(Path.Combine(Dir, "browse.txt")); i++) Thread.Sleep(100);
        Console.WriteLine(File.Exists(Path.Combine(Dir, "browse.txt")) ? "the browser did not take the address" : "the browser went to " + url); return 0;
      }
      case "wait": {
        double s = Math.Min(120, double.Parse(a[1], System.Globalization.CultureInfo.InvariantCulture));
        Thread.Sleep((int)(s * 1000)); Console.WriteLine("waited " + s + " s"); return 0;
      }
    }
    Console.WriteLine("unknown: " + cmd); return 1;
  }
}
