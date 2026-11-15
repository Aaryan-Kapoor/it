# One window of the rehearsal's own, found by the start of its title, and what the harness does with it:
# put it on top of everything and over the whole screen, give it the keyboard, and type into it
# only while it, and no other window, has the keyboard. For windows whose process may be shared
# with the owner's own (Windows Terminal keeps every window in one process), so that a window is
# named by its handle and never by its process.
#
#   powershell -File win.ps1 place <title> [x y w h]      on top, at that place (default: the screen)
#   powershell -File win.ps1 type <title> <text>          typed, then Enter if the text ends in \n
#   powershell -File win.ps1 key <title> enter
#   powershell -File win.ps1 pid <title>                  the process id of the window
#   powershell -File win.ps1 shot <title> <file.png>      the window's own rectangle, only where every point of it is this window
#   powershell -File win.ps1 close <title>                every window whose title begins so is asked to close
#   powershell -File win.ps1 topmost-pid <pid>            every visible window of a process the harness started, on top
param([string]$cmd, [string]$title, [Parameter(ValueFromRemainingArguments = $true)][string[]]$rest)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace It -Name Win -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit, Size = 40)] public struct KI { [System.Runtime.InteropServices.FieldOffset(0)] public uint type; [System.Runtime.InteropServices.FieldOffset(8)] public ushort wVk; [System.Runtime.InteropServices.FieldOffset(10)] public ushort wScan; [System.Runtime.InteropServices.FieldOffset(12)] public uint dwFlags; [System.Runtime.InteropServices.FieldOffset(16)] public uint time; [System.Runtime.InteropServices.FieldOffset(24)] public System.IntPtr extra; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint SendInput(uint n, KI[] inputs, int size);
public struct R { public int L, T, Rr, B; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out R r);
public struct PT { public int X, Y; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(PT p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr h, uint f);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, System.UIntPtr extra);
public static System.IntPtr RootAt(int x, int y) { var p = new PT(); p.X = x; p.Y = y; return GetAncestor(WindowFromPoint(p), 2); }
public static System.Collections.Generic.List<System.IntPtr> Found = new System.Collections.Generic.List<System.IntPtr>();
public static void Find(string title) {
  Found.Clear();
  EnumWindows((h, l) => {
    if (!IsWindowVisible(h)) return true;
    var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512);
    if (sb.ToString().StartsWith(title)) Found.Add(h);
    return true;
  }, System.IntPtr.Zero);
}
public static void OfPid(uint want) {
  Found.Clear();
  EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == want && IsWindowVisible(h)) Found.Add(h); return true; }, System.IntPtr.Zero);
}
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern short VkKeyScan(char c);
public static void Char(char c) {
  // The classic console takes only real keys: an ASCII character is typed as its key, with Shift where needed
  short k = c < 128 ? VkKeyScan(c) : (short)-1;
  if (k != -1) {
    byte vk = (byte)(k & 0xff); bool shift = (k & 0x100) != 0;
    if (shift) keybd_event(0x10, 0, 0, System.UIntPtr.Zero);
    keybd_event(vk, 0, 0, System.UIntPtr.Zero); keybd_event(vk, 0, 2, System.UIntPtr.Zero);
    if (shift) keybd_event(0x10, 0, 2, System.UIntPtr.Zero);
    return;
  }
  var a = new KI[2];
  a[0].type = 1; a[0].wScan = c; a[0].dwFlags = 4;
  a[1].type = 1; a[1].wScan = c; a[1].dwFlags = 6;
  SendInput(2, a, System.Runtime.InteropServices.Marshal.SizeOf(typeof(KI)));
}
'@
[void][It.Win]::SetProcessDPIAware()
function One($t) {
  [It.Win]::Find($t)
  if ([It.Win]::Found.Count -ne 1) { throw "expected one window titled '$t', found $([It.Win]::Found.Count)" }
  return [It.Win]::Found[0]
}
function Front($h) {
  [void][It.Win]::ShowWindow($h, 9)
  [void][It.Win]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x3)
  [void][It.Win]::BringWindowToTop($h)
  [void][It.Win]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 300
  if ([It.Win]::GetForegroundWindow() -ne $h) {
    # Windows gives the keyboard to a window that is clicked: a click in the middle of this
    # window, only once it is sure that the point is this window's
    $r = New-Object It.Win+R
    [void][It.Win]::GetWindowRect($h, [ref]$r)
    $x = [int](($r.L + $r.Rr) / 2); $y = [int](($r.T + $r.B) / 2)
    if ([It.Win]::RootAt($x, $y) -eq $h) {
      [void][It.Win]::SetCursorPos($x, $y)
      [It.Win]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [It.Win]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 400
    }
  }
  if ([It.Win]::GetForegroundWindow() -ne $h) { throw "the window '$title' does not have the keyboard; nothing typed" }
}
switch ($cmd) {
  'place' {
    $h = One $title
    $r = if ($rest.Count -ge 4) { $rest | ForEach-Object { [int]$_ } } else { @(0, 0, 2560, 1376) }
    [void][It.Win]::ShowWindow($h, 9)
    [void][It.Win]::SetWindowPos($h, [IntPtr](-1), $r[0], $r[1], $r[2], $r[3], 0x40)
    'placed'
  }
  'type' {
    $h = One $title
    Front $h
    $text = ($rest -join ' ')
    $enter = $text.EndsWith('\n')
    if ($enter) { $text = $text.Substring(0, $text.Length - 2) }
    foreach ($c in $text.ToCharArray()) {
      if ([It.Win]::GetForegroundWindow() -ne $h) { throw 'the keyboard moved to another window; typing stopped' }
      [It.Win]::Char($c); Start-Sleep -Milliseconds 25
    }
    if ($enter) { [It.Win]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero); [It.Win]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero) }
    "typed $($text.Length) characters"
  }
  'key' {
    $h = One $title
    Front $h
    $vk = @{ enter = 0x0D; esc = 0x1B }[$rest[0]]
    [It.Win]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero); [It.Win]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
    'pressed'
  }
  'shot' {
    # Only the window's rectangle is copied, and only once a grid of points over it all belong to
    # it: nothing of another window can be in the picture
    $h = One $title
    $r = New-Object It.Win+R
    [void][It.Win]::GetWindowRect($h, [ref]$r)
    # Inside the invisible resize border Windows puts around a window, where what is behind shows
    $r.L += 16; $r.T += 16; $r.Rr -= 16; $r.B -= 16
    $w = $r.Rr - $r.L; $hh = $r.B - $r.T
    for ($i = 1; $i -lt 12; $i++) { for ($j = 1; $j -lt 8; $j++) {
      $x = $r.L + [int]($w * $i / 12); $y = $r.T + [int]($hh * $j / 8)
      if ([It.Win]::RootAt($x, $y) -ne $h) { throw "another window is over '$title' at $x,$y; no picture taken" }
    } }
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($rest[0], [System.Drawing.Imaging.ImageFormat]::Png)
    "saved $($rest[0])"
  }
  'close' {
    [It.Win]::Find($title)
    foreach ($h in [It.Win]::Found) { [void][It.Win]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
    "asked $([It.Win]::Found.Count) to close"
  }
  'pid' { $h = One $title; $p = 0; [void][It.Win]::GetWindowThreadProcessId($h, [ref]$p); $p }
  'topmost-pid' {
    [It.Win]::OfPid([uint32]$title)
    foreach ($h in [It.Win]::Found) { [void][It.Win]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x13) }
    "raised $([It.Win]::Found.Count)"
  }
}
