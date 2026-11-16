# The NAMES of the environment variables a running process of this account has (never their
# values), read from the process's own memory, and whether its PATH holds It's folder
# (\.it\bin). For comparing a conversation It reopens with the terminal the person started it in.
#   powershell -NoProfile -File env-names.ps1 <pid>
param([int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EnvNames {
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr r1; public IntPtr Peb; public IntPtr r2a; public IntPtr r2b; public IntPtr Pid; public IntPtr r3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI i, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr s, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static IntPtr Ptr(IntPtr h, IntPtr a) { var b = new byte[8]; IntPtr r; if (!ReadProcessMemory(h, a, b, (IntPtr)8, out r)) throw new Exception("read"); return (IntPtr)BitConverter.ToInt64(b, 0); }
  public static string Block(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) throw new Exception("open");
    try {
      var i = new PBI(); int r;
      if (NtQueryInformationProcess(h, 0, ref i, Marshal.SizeOf(i), out r) != 0) throw new Exception("query");
      IntPtr pp = Ptr(h, i.Peb + 0x20);
      IntPtr env = Ptr(h, pp + 0x80);
      var sz = new byte[8]; IntPtr rr;
      ReadProcessMemory(h, pp + 0x3F0, sz, (IntPtr)8, out rr);
      long n = BitConverter.ToInt64(sz, 0);
      if (n <= 0 || n > 4 * 1024 * 1024) n = 64 * 1024;
      var b = new byte[n];
      ReadProcessMemory(h, env, b, (IntPtr)n, out rr);
      return System.Text.Encoding.Unicode.GetString(b, 0, (int)rr);
    } finally { CloseHandle(h); }
  }
}
'@
$block = [EnvNames]::Block($ProcessId)
$names = @()
$pathHasIt = $false
foreach ($entry in ($block -split "`0")) {
  if (-not $entry) { break }
  $at = $entry.IndexOf('=', 1)
  if ($at -lt 1) { continue }
  $name = $entry.Substring(0, $at)
  $names += $name
  if ($name -ieq 'PATH') {
    $dirs = @($entry.Substring($at + 1) -split ';' | Where-Object { $_ })
    $pathHasIt = $dirs -match '\\\.it\\bin\\?$' | Select-Object -First 1 | ForEach-Object { $true }
    # What each folder is, never the folder itself where it is under a profile: It's folder, the
    # harness's guard, the agent app's, a throwaway's, the system's, or another
    $kinds = @($dirs | ForEach-Object {
        if ($_ -match '\\\.it\\bin\\?$') { 'IT' } elseif ($_ -match 'it-rehearsal\\work\\guard') { 'GUARD' }
        elseif ($_ -match 'it-rehearsal\\work\\apps') { 'APP' } elseif ($_ -match '^D:\\r\\') { 'THROWAWAY' }
        elseif ($_ -match '^C:\\Windows' -or $_ -match '^C:\\Program Files') { 'SYSTEM' } elseif ($_ -match '\\Users\\') { 'PROFILE' } else { 'OTHER' } })
  }
}
[pscustomobject]@{ pid = $ProcessId; names = ($names | Sort-Object -Unique); pathHasItBin = [bool]$pathHasIt; pathFirst = ($kinds | Select-Object -First 1); pathKinds = ($kinds -join ',') } | ConvertTo-Json -Compress
