# Installs It on your computer: one program, in ~\.it\bin.
#
#   irm https://itcan.do/install.ps1 | iex
#
# It downloads the program, checks it against the published checksum, and puts it in ~\.it\bin,
# with the license it comes under and the notices of what it includes in ~\.it. It needs
# Windows PowerShell 5.1 or a later PowerShell. It needs no administrator rights, and asks for
# none.
#
# What it installs goes in ~\.it, or in the folder IT_HOME names instead, and that folder is set
# so that only you, the system and its administrators can open it. Outside that folder it
# changes one thing: the program's folder is added to the PATH that Windows keeps for your own
# account.
#
# IT_INSTALL_BASE names another place to download from, laid out as GitHub lays out a
# repository's releases. IT_VERSION names a release other than the latest, by its tag.
# IT_INSTALL_NO_PATH, set to anything, leaves your PATH alone.
#
# Everything runs inside a block of its own, so that running this as `irm ... | iex` leaves
# nothing behind in the session it was run from: no variable, no function, no changed setting.
& {
  $ErrorActionPreference = 'Stop'
  $base = if ($env:IT_INSTALL_BASE) { $env:IT_INSTALL_BASE.TrimEnd('/') } else { 'https://itcan.do/releases' }
  $version = if ($env:IT_VERSION) { $env:IT_VERSION } else { 'latest' }
  if ($version -notmatch '^[A-Za-z0-9._-]+$') { throw "IT_VERSION must be a release's tag." }
  $from = if ($version -eq 'latest') { "$base/latest/download" } else { "$base/download/$version" }
  # Only over https, and a redirect may only lead to https. The one exception is a base on this
  # machine itself, which is how the install is tested before anything is published: it must be
  # exactly this machine and a port, with nothing before it that could be read as a name and
  # password, it is not followed anywhere else, and it is asked directly, whatever proxy this
  # system is set to use: a proxy would carry what is asked of this machine off it, in the clear.
  $plain = $base -match '^http://(127\.0\.0\.1|localhost):[0-9]+(/|$)'
  if (-not $plain -and $base -notmatch '^https://') { throw 'IT_INSTALL_BASE must be an https address.' }
  if (-not $env:IT_HOME -and -not $env:USERPROFILE) { throw 'Neither USERPROFILE nor IT_HOME is set, so there is nowhere to install It.' }
  # A folder given as a relative path is taken from where this was run, as PowerShell knows it:
  # after a `cd`, that is not where Windows takes a relative path from
  $root = if ($env:IT_HOME) { [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location -PSProvider FileSystem).ProviderPath, $env:IT_HOME)) } else { Join-Path $env:USERPROFILE '.it' }
  $dir = Join-Path $root 'bin'
  $name = 'it-windows-x64.exe'
  $target = Join-Path $dir 'it.exe'
  $license = Join-Path $root 'LICENSE.md'
  $notices = Join-Path $root 'THIRD_PARTY_NOTICES.md'
  # Made by its name exactly as it is, whatever characters are in it
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  # Only this user may look inside It's folder: the machine's key is kept there. Whatever access
  # the folder would take from the one it is in is set aside, and this user, the system and its
  # administrators are named instead, for the folder and for everything in it. Only that list
  # is set, and nothing else about the folder: the rest is not an ordinary user's to set, and
  # asking to set it is refused. The two kinds of PowerShell set it, and read it, by different
  # names.
  $may = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  $folder = New-Object IO.DirectoryInfo $root
  try {
    $only = New-Object Security.AccessControl.DirectorySecurity
    $only.SetAccessRuleProtection($true, $false)
    foreach ($who in $may) {
      $only.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ([Security.Principal.SecurityIdentifier]$who), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($folder, $only) } else { $folder.SetAccessControl($only) }
  } catch {}
  # Setting the list can be refused, in a folder that is someone else's to set, and on a disk
  # that keeps no such lists it does nothing. So who the folder lets in is read back from the
  # folder itself: one that has no list, or whose list lets in anyone but those three, is not
  # installed into, and that is found out before anything is downloaded.
  $private = $false
  try {
    $list = if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::GetAccessControl($folder) } else { $folder.GetAccessControl() }
    $allowed = @($list.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' })
    $others = @($allowed | Where-Object { $may -notcontains $_.IdentityReference.Value })
    $private = $allowed.Count -gt 0 -and $others.Count -eq 0
  } catch {}
  if (-not $private) { throw "$root could not be set so that only you, the system and its administrators can open it, and It keeps this machine's key there. Nothing was installed. Set IT_HOME to a folder of your own that can be." }
  # What is at a path itself, and never what a link there leads to: nothing, a file, a link to
  # a file, or a folder, which a link to a folder counts as. Only a symbolic link is a link: a
  # file in a folder that OneDrive keeps carries the same mark, and is an ordinary file.
  function Get-Kind($path) {
    try { $is = [IO.File]::GetAttributes($path) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return 'nothing' }
    if (($is -band [IO.FileAttributes]::Directory) -ne 0) { return 'folder' }
    if (($is -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      try { if ((Get-Item -LiteralPath $path -Force).LinkType -eq 'SymbolicLink') { return 'link' } } catch {}
    }
    return 'file'
  }
  # A folder where one of the three files is to go is never installed over, nor into, and that
  # is found out before anything is downloaded
  function Assert-NoFolder($path) {
    if ((Get-Kind $path) -eq 'folder') { throw "$path is a folder, and It is not installed over one. Nothing was installed." }
  }
  foreach ($place in $target, $license, $notices) { Assert-NoFolder $place }
  # What is downloaded is kept, until it has been checked, in a folder made for this run inside
  # It's own, under a name that cannot be guessed, so that nothing can have been put in it
  # beforehand
  $stage = Join-Path $root ('.install.' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($stage) | Out-Null
  # Windows PowerShell on an older system does not offer TLS 1.2 unless asked to. It is asked
  # for the length of this install, and the session's setting is put back afterwards. A session
  # that leaves the choice to Windows is left as it is: Windows offers it already.
  $tls = [Net.ServicePointManager]::SecurityProtocol
  $lock = $null
  $places = @()
  $replacing = $false
  $kept = $false
  try {
    if ([int]$tls -ne 0) { try { [Net.ServicePointManager]::SecurityProtocol = $tls -bor [Net.SecurityProtocolType]::Tls12 } catch {} }
    # Each download is asked for one address at a time, so that where a redirect may lead is
    # decided here and not by whichever PowerShell this is: Windows PowerShell, left to itself,
    # follows one from https to plain http. Only a few are followed, and only to https.
    function Get-File($address, $to) {
      $at = [Uri]$address
      for ($hops = 0; ; $hops++) {
        $request = [Net.WebRequest]::Create($at)
        $request.AllowAutoRedirect = $false
        $request.UserAgent = 'it-install'
        # A proxy that has no address is no proxy at all
        if ($plain) { $request.Proxy = New-Object Net.WebProxy }
        # An answer that is a refusal comes as an error, with the answer inside it
        try { $response = $request.GetResponse() } catch {
          $failed = $_.Exception
          while ($failed -and $failed -isnot [Net.WebException]) { $failed = $failed.InnerException }
          if (-not $failed -or -not $failed.Response) { throw }
          $response = $failed.Response
        }
        try {
          $status = [int]$response.StatusCode
          if ($status -eq 200) {
            # Made new, in the folder made for this run: where anything is already, this fails
            $file = [IO.File]::Open($to, [IO.FileMode]::CreateNew)
            try { $response.GetResponseStream().CopyTo($file) } finally { $file.Dispose() }
            return
          }
          $next = $response.Headers['Location']
          if ($status -lt 300 -or $status -ge 400 -or -not $next) { throw "The download of $address was answered with $status and no file. Nothing was installed." }
          if ($plain) { throw "The download of $address was sent on to another address, which is not followed from this machine. Nothing was installed." }
          if ($hops -ge 10) { throw "The download of $address was sent on too many times. Nothing was installed." }
          $at = New-Object Uri $at, $next
          if ($at.Scheme -ne 'https') { throw "The download of $address was sent on to an address that is not https. Nothing was installed." }
        } finally { $response.Close() }
      }
    }
    Write-Host 'It is being downloaded for Windows.'
    Get-File "$from/SHA256SUMS" (Join-Path $stage 'sums')
    # Read as text whatever the server called it, without a mark at its start, one line at a time
    $sums = ([IO.File]::ReadAllText((Join-Path $stage 'sums'))).TrimStart([char]0xFEFF) -split "`r?`n"
    # Each file is checked against the published checksum before it is put anywhere. The line
    # for a file is the one whose name is exactly that file's, and its checksum is 64 hex digits.
    function Get-Checked($file, $to) {
      Get-File "$from/$file" $to
      $want = $null
      foreach ($line in $sums) { if ($line -match "^([0-9a-f]{64})  $([regex]::Escape($file))$") { $want = $Matches[1]; break } }
      $have = (Get-FileHash -Algorithm SHA256 -LiteralPath $to).Hash.ToLower()
      if (-not $want -or $want -ne $have) { throw "The download of $file does not match its published checksum. Nothing was installed." }
    }
    Get-Checked $name (Join-Path $stage 'program.exe')
    Get-Checked 'LICENSE.md' (Join-Path $stage 'license')
    Get-Checked 'THIRD_PARTY_NOTICES.md' (Join-Path $stage 'notices')
    # A program that cannot start on this system is not installed: one built for another kind of
    # chip, one that is no program at all, or one this system refuses to run. It is started with
    # a folder of its own to keep anything in, which goes when the folder made for this run
    # does, and that folder is named to it alone: nothing of this session is changed. It is
    # given nothing to read and half a minute to answer, and what it prints is read and dropped.
    $starts = $false
    try {
      $how = New-Object Diagnostics.ProcessStartInfo
      $how.FileName = Join-Path $stage 'program.exe'
      $how.Arguments = '--version'
      $how.WorkingDirectory = $stage
      $how.UseShellExecute = $false
      $how.CreateNoWindow = $true
      $how.RedirectStandardInput = $true
      $how.RedirectStandardOutput = $true
      $how.RedirectStandardError = $true
      $how.EnvironmentVariables['IT_HOME'] = $stage
      $trial = [Diagnostics.Process]::Start($how)
      try {
        $trial.StandardInput.Close()
        $printed = $trial.StandardOutput.ReadToEndAsync(), $trial.StandardError.ReadToEndAsync()
        if ($trial.WaitForExit(30000)) { $starts = $trial.ExitCode -eq 0 } else { try { $trial.Kill(); $trial.WaitForExit(5000) | Out-Null } catch {} }
        $printed | Out-Null
      } finally { $trial.Dispose() }
    } catch {}
    if (-not $starts) { throw 'The program for Windows does not start on this system. Nothing was installed.' }
    # One install at a time puts its files in place. The lock is a file, which only one can
    # make. It is held open for the moment the replacing takes, and Windows removes it when it
    # is closed, which it is when this ends, however this ends. One that no install holds was
    # left when the machine itself stopped, and is removed here; one that an install holds
    # cannot be.
    function Open-Lock {
      [IO.FileStream]::new((Join-Path $root '.installing'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
    }
    try { $lock = Open-Lock } catch {
      try { [IO.File]::Delete((Join-Path $root '.installing')); $lock = Open-Lock }
      catch { throw "Another install of It is putting its files in $root. Run this again when it has finished." }
    }
    # The three files are put in place together or not at all. Each goes in by a move, which
    # never writes through a link to wherever it leads and never goes into a folder. What was
    # at each place is moved aside first and kept until all three are in, and is put back if
    # anything stops this before then. A program that is running cannot be written over or
    # removed, and can be renamed: so the old program is kept beside the new one under another
    # name, and the old terms in the folder made for this run.
    $places = @(
      @{ New = (Join-Path $stage 'program.exe'); At = $target; Old = (Join-Path $dir ('it.old.{0}.exe' -f [DateTime]::UtcNow.Ticks)); Begun = $false },
      @{ New = (Join-Path $stage 'license'); At = $license; Old = (Join-Path $stage 'old.license'); Begun = $false },
      @{ New = (Join-Path $stage 'notices'); At = $notices; Old = (Join-Path $stage 'old.notices'); Begun = $false }
    )
    $replacing = $true
    foreach ($place in $places) {
      Assert-NoFolder $place.At
      if ((Get-Kind $place.At) -ne 'nothing') { [IO.File]::Move($place.At, $place.Old) }
      $place.Begun = $true
      [IO.File]::Move($place.New, $place.At)
    }
    $replacing = $false
    # Earlier programs that were moved aside are removed once they have stopped running. One
    # that still runs is left for the next install to remove.
    Get-ChildItem -LiteralPath $dir -Filter 'it.old.*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
      try { Remove-Item -Force -LiteralPath $_.FullName } catch {}
    }
    $lock.Dispose()
    $lock = $null
    # Where this was downloaded from, when it was not the usual place, is noted for the program:
    # it looks there for a newer It, and is updated from there. Asked later, from another
    # terminal, it would not know, and would turn to the usual place for both.
    # A note left by an earlier install from another place is taken away by one from the usual place.
    if ($base) {
      $note = Join-Path $root 'releases.json'
      try {
        if ($base -eq 'https://itcan.do/releases') { if (Test-Path -LiteralPath $note) { Remove-Item -Force -LiteralPath $note } }
        else {
          $part = "$note.$PID"
          [IO.File]::WriteAllText($part, (ConvertTo-Json @{ base = $base } -Compress) + "`n", (New-Object Text.UTF8Encoding $false))
          Move-Item -Force -LiteralPath $part -Destination $note
        }
      } catch {
        Write-Host "Where this was downloaded from could not be noted in $root, so It will look for a newer version where it looked before, and not at $base."
      }
    }
    # The folder is put first on the PATH that Windows keeps for this account. That PATH is
    # read and written as it is kept, with a name such as %USERPROFILE% left as a name: read the
    # usual way, every such name comes back as what it stands for today, and writing that back
    # would fix it there for good. It is written back as the kind of value it was.
    if (-not $env:IT_INSTALL_NO_PATH) {
      try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
        try {
          $path = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          # Whether the folder is there already is asked of each entry as Windows would read it
          $there = @($path -split ';' | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
          if ($there -notcontains $dir) {
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
            $new = if ($path) { "$dir;$path" } else { $dir }
            $key.SetValue('Path', $new, $kind)
            # Programs that are running learn that the PATH has changed when they are told that
            # the environment has, and it is the desktop, told so, that gives a new terminal the
            # new PATH. They are told directly, by the message Windows has for it, and nothing
            # else of this account's is set or removed to make Windows send it. Where they could
            # not be told, the PATH is the new one from the next time this account signs in.
            $told = $false
            try {
              $user32 = Add-Type -Namespace 'ItInstall' -Name 'Windows' -PassThru -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr first, string second, uint flags, uint milliseconds, out UIntPtr result);'
              $answer = [UIntPtr]::Zero
              # To every window, that a setting has changed, and which: not waiting on one that has hung
              $told = $user32::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$answer) -ne [IntPtr]::Zero
            } catch {}
            if ($told) { Write-Host "Added $dir to your PATH. Open a new terminal to use it." }
            else { Write-Host "Added $dir to your PATH. Sign out of Windows and in again to use it in a new terminal." }
          }
        } finally { $key.Close() }
      } catch { Write-Host "Your PATH could not be changed. Add $dir to it yourself." }
    }
    # The program's path as PowerShell reads it back exactly, whatever characters are in it. A
    # command printed for a person to copy must be the command that was meant, and between single
    # quotes nothing is read as more than itself but the quote, which is written twice.
    # PowerShell reads four other characters as that quote, and they are written twice too.
    $quoted = "'" + ($target -replace "['\u2018\u2019\u201A\u201B]", '$0$0') + "'"
    # It reports how it is used, and says so here, in the sentence the program itself says,
    # unless that has been turned off already by the file the program keeps for it. Where one
    # of the two variables that turn it off is set at all, reading it is left to the program,
    # and nothing is said here. The program goes by that file and those two variables and by
    # nothing else, so nothing else is read here either: whatever its note of what it told the
    # person holds, the sentence is said.
    $note = Join-Path $root 'telemetry.json'
    $reporting = (Get-Kind (Join-Path $root 'telemetry-off')) -eq 'nothing'
    if ($env:IT_TELEMETRY_ENABLED -or $env:DO_NOT_TRACK) { $reporting = $false }
    if ($reporting) {
      $sentence = 'It reports usage counts under a random id for this installation, and never what is on a page. Turn it off with `' + "& $quoted" + ' telemetry off` or IT_TELEMETRY_ENABLED=false. What is sent: https://itcan.do/usage-reporting'
      # The note left in It's folder is how the program knows this has been said to a person,
      # so that it does not say it again. So it is left only once the sentence is printed, and
      # only where a person was there to read it: in a console window, and not inside an agent's
      # conversation. There the sentence is written to the window itself, and not through
      # PowerShell, which may have been told to send what a script prints somewhere else while
      # the window is still there: what the note says was read is what was put in the window.
      # Anywhere else it is printed as everything else here is, no note is left, and the
      # program's first command at a terminal says it. The note is made only where nothing at
      # all is, and by a move, which puts it there or fails: a link put there is never written
      # through.
      $window = $false
      try { $window = $Host.Name -eq 'ConsoleHost' -and -not [Console]::IsOutputRedirected } catch {}
      $agent = "$env:CLAUDE_CODE_SESSION_ID$env:CODEX_THREAD_ID$env:OPENCLAW_SESSION_ID$env:HERMES_SESSION_ID$env:OPENCODE_SESSION_ID$env:PI_SESSION_ID$env:IT_SESSION"
      $seen = $false
      if ($window -and -not $agent) {
        try { [Console]::Out.WriteLine($sentence); [Console]::Out.Flush(); $seen = $true } catch {}
      }
      if (-not $seen) { Write-Host $sentence }
      if ($seen -and (Get-Kind $note) -eq 'nothing') {
        try {
          [IO.File]::WriteAllText((Join-Path $stage 'note'), ('{"told": ' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}'))
          [IO.File]::Move((Join-Path $stage 'note'), $note)
        } catch {}
      }
    }
    Write-Host "It is source-available software under the It License, which is in $license."
    Write-Host 'It is installed. Start it, and connect your agents, with:'
    Write-Host ''
    Write-Host "  & $quoted setup"
  } finally {
    # Stopped before all three were in, what was there is put back: the old file where one was
    # kept, and nothing where the new file went in over nothing. What is there now is taken
    # away only if this run put it there. A file that cannot be put back is the only copy there
    # is: it stays where it was kept, and the person is told where.
    if ($replacing) {
      foreach ($place in $places) {
        $old = 'nothing'
        try { $old = Get-Kind $place.Old } catch { $old = 'unknown' }
        if ($old -ne 'nothing') {
          try {
            if ((Get-Kind $place.At) -ne 'nothing') { [IO.File]::Delete($place.At) }
            [IO.File]::Move($place.Old, $place.At)
          } catch {
            $kept = $true
            Write-Host "What was at $($place.At) before could not be put back. It is kept as $($place.Old)."
          }
        } elseif ($place.Begun) {
          try { if ((Get-Kind $place.New) -eq 'nothing') { [IO.File]::Delete($place.At) } } catch {}
        }
      }
    }
    # The folder made for this run goes, with whatever is still in it, and then the lock
    if (-not $kept) { try { [IO.Directory]::Delete($stage, $true) } catch {} }
    if ($lock) { try { $lock.Dispose() } catch {} }
    try { [Net.ServicePointManager]::SecurityProtocol = $tls } catch {}
  }
}
