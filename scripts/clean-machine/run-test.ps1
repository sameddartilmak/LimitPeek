# Clean-machine first-run test for Usage Notch, run INSIDE Windows Sandbox.
# Started by start.ps1, which maps these two folders in from the host.
# Input (read-only): C:\UsageNotchTest\in  -> setup.exe, this script
# Output (writable): C:\UsageNotchTest\out -> report.txt, screenshots
$ErrorActionPreference = 'Continue'
$in = 'C:\UsageNotchTest\in'
$out = 'C:\UsageNotchTest\out'
$report = Join-Path $out 'report.txt'
function Say($s) { $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $s; Add-Content -Path $report -Value $line -Encoding UTF8 }
Set-Content -Path $report -Value "Usage Notch clean-machine test" -Encoding UTF8

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# DPI-aware, or Screen.Bounds is the SCALED size and every capture is only the
# top-left of the desktop: the taskbar and the panel above the tray fall
# outside it (2026-10-01 run, 1214x651 of a scaled screen).
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class UnDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h); [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc); [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L, T, R, B; } }'
[void][UnDpi]::SetProcessDPIAware()
function Shot($name) {
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    # SRCCOPY | CAPTUREBLT, or layered (transparent) windows such as the panel
    # are left out and the capture shows only the desktop behind them.
    # CopyFromScreen rejects that combination, so call BitBlt directly.
    $src = [UnDpi]::GetDC([IntPtr]::Zero); $dst = $g.GetHdc()
    [void][UnDpi]::BitBlt($dst, 0, 0, $b.Width, $b.Height, $src, $b.X, $b.Y, 0x40CC0020)
    $g.ReleaseHdc($dst); [void][UnDpi]::ReleaseDC([IntPtr]::Zero, $src)
    # The panel is transparent, so Chromium draws it through DirectComposition
    # and no screen BitBlt sees it. Ask each app window for its own picture
    # (PW_RENDERFULLCONTENT) and lay it over the desktop where it sits.
    Get-Process -Name 'Usage Notch' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
      $r = New-Object UnDpi+RECT
      if ([UnDpi]::GetWindowRect($_.MainWindowHandle, [ref]$r) -and $r.R -gt $r.L -and $r.B -gt $r.T) {
        $wb = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
        $wg = [System.Drawing.Graphics]::FromImage($wb); $wdc = $wg.GetHdc()
        $ok = [UnDpi]::PrintWindow($_.MainWindowHandle, $wdc, 2)
        $wg.ReleaseHdc($wdc); $wg.Dispose()
        if ($ok) { $g.DrawImage($wb, $r.L - $b.X, $r.T - $b.Y) }
        $wb.Dispose()
        Say ("  window ""{0}"" at {1},{2} {3}x{4} printed: {5}" -f $_.MainWindowTitle, $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T), $ok)
      }
    }
    $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Say "screenshot $name ($($b.Width)x$($b.Height))"
  } catch { Say "screenshot $name FAILED: $($_.Exception.Message)" }
}
function Tree($label, $path) {
  if (Test-Path $path) {
    Say "$label exists: $path"
    Get-ChildItem $path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
      Say ("   {0}  {1}" -f $_.FullName.Substring($path.Length), $(if ($_.PSIsContainer) { '<dir>' } else { $_.Length }))
    }
  } else { Say "$label absent: $path" }
}

Say ("Windows: " + (Get-CimInstance Win32_OperatingSystem).Caption + " " + [Environment]::OSVersion.Version)
Say "user: $env:USERNAME  home: $env:USERPROFILE"
foreach ($d in '.claude', '.codex', '.gemini', '.kimi-code', '.qwen', '.grok') { Say ("tool dir {0}: {1}" -f $d, (Test-Path (Join-Path $env:USERPROFILE $d))) }
Start-Sleep -Seconds 5
Shot '0-desktop-before'

# ---- install (the one-click installer, silently, as an update would) ----
$sig = Get-AuthenticodeSignature (Join-Path $in 'setup.exe')
Say "installer signature: $($sig.Status) / $($sig.SignerCertificate.Subject)"
$t = Get-Date
$p = Start-Process (Join-Path $in 'setup.exe') -ArgumentList '/S' -Wait -PassThru
Say ("install exit {0} in {1:N1}s" -f $p.ExitCode, ((Get-Date) - $t).TotalSeconds)
Start-Sleep -Seconds 3
$instDir = Join-Path $env:LOCALAPPDATA 'Programs\usage-notch'
$exe = Join-Path $instDir 'Usage Notch.exe'
Say "installed exe present: $(Test-Path $exe)"
if (Test-Path $exe) { Say "version: $((Get-Item $exe).VersionInfo.ProductVersion)" }
Say ("start menu shortcut: " + (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Usage Notch.lnk')))
Say ("desktop shortcut: " + (Test-Path (Join-Path $env:USERPROFILE 'Desktop\Usage Notch.lnk')))
$uninst = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Usage Notch*' }
Say ("uninstall entry: " + ($uninst | Select-Object -First 1 | ForEach-Object { "$($_.DisplayName) $($_.DisplayVersion)" }))
Shot '1-after-install'

# ---- first launch ----------------------------------------------------------
$running = Get-Process -Name 'Usage Notch' -ErrorAction SilentlyContinue
Say "running right after install (installer auto-run?): $([bool]$running)"
if (-not $running) { Start-Process $exe; Say 'launched the app' }
Start-Sleep -Seconds 20
$procs = Get-Process -Name 'Usage Notch' -ErrorAction SilentlyContinue
Say "processes after 20s: $(@($procs).Count)"
Shot '2-after-first-launch'

# A second launch opens the panel pinned (second-instance -> openPinned), so
# it must still be on screen in both shots below.
Start-Process $exe
Start-Sleep -Seconds 6
# Which app windows are actually on screen, independent of the screenshot.
$wins = Get-Process -Name 'Usage Notch' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
Say ("visible app windows after the second launch: " + @($wins).Count + " " + (($wins | ForEach-Object { '"' + $_.MainWindowTitle + '"' }) -join ', '))
Shot '3-panel-open'
Start-Sleep -Seconds 10
Shot '4-panel-after-10s'

Say ("Run key: " + ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -like '*sage*' } | ForEach-Object { "$($_.Name) = $($_.Value)" }))
Tree 'userData' (Join-Path $env:APPDATA 'usage-notch')
Tree 'LocalAppData UsageNotch' (Join-Path $env:LOCALAPPDATA 'UsageNotch')
Say ("home .usage-notch: " + (Test-Path (Join-Path $env:USERPROFILE '.usage-notch')))
$settings = Join-Path $env:APPDATA 'usage-notch\settings.json'
if (Test-Path $settings) { Say ("settings.json: " + (Get-Content $settings -Raw)) }
$tcp = Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in @($procs.Id) }
Say ("TCP connections owned by the app: " + @($tcp).Count)
$crash = Get-ChildItem (Join-Path $env:APPDATA 'usage-notch') -Recurse -Filter '*.dmp' -ErrorAction SilentlyContinue
Say ("crash dumps: " + @($crash).Count)
Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 2; StartTime = $t } -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -like '*Usage Notch*' } | Select-Object -First 5 | ForEach-Object { Say "app error event: $($_.Message.Substring(0, [Math]::Min(300, $_.Message.Length)))" }

# ---- update over the same install (the 2026-10-01 regression) -----------------
# An update finds the old uninstaller through UninstallString. 0.6.11 pointed it
# at the app and every update failed with "Failed to uninstall old application
# files". Installing the same build again walks exactly that path.
$t = Get-Date
$p2 = Start-Process (Join-Path $in 'setup.exe') -ArgumentList '/S' -Wait -PassThru
Say ("UPDATE over itself: exit {0} in {1:N1}s, exe present: {2}" -f $p2.ExitCode, ((Get-Date) - $t).TotalSeconds, (Test-Path $exe))
Start-Process $exe
Start-Sleep -Seconds 8

# ---- Windows "Kaldır": the app's own question --------------------------------
# UninstallString runs the uninstaller silently with --ask; it starts the app's
# question and waits for its exit code. The script cannot click, so it
# photographs the question and then closes it, which the uninstaller reads as
# "remove, keep the data".
$entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Usage Notch*' } | Select-Object -First 1
Say ("UninstallString: " + $entry.UninstallString)
$un = Join-Path $instDir 'Uninstall Usage Notch.exe'
$t2 = Get-Date
Start-Process $un -ArgumentList '/currentuser', '/S', '--ask' | Out-Null
# The uninstaller re-launches itself from %TEMP%, closes the tray app, then
# starts the question: poll for it rather than guess how long that takes.
$prompt = $null
for ($i = 0; $i -lt 45 -and -not $prompt; $i++) {
  Start-Sleep -Seconds 1
  $prompt = Get-Process -Name 'Usage Notch' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*kald*' -or $_.MainWindowTitle -like '*Uninstall*' }
}
Say ("uninstall prompt window after {0}s: {1} {2}" -f ((Get-Date) - $t2).TotalSeconds.ToString('N0'), @($prompt).Count, (($prompt | ForEach-Object { '"' + $_.MainWindowTitle + '"' }) -join ', '))
Start-Sleep -Seconds 1
Shot '5a-uninstall-prompt'
$prompt | Stop-Process -Force -ErrorAction SilentlyContinue
# The uninstaller runs from %TEMP% under another name: wait for the app's
# folder to go instead of for a process.
for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 4
Say ("uninstall (prompt closed = keep data) done in {0:N1}s" -f ((Get-Date) - $t2).TotalSeconds)
Say ("  app removed: " + (-not (Test-Path $exe)) + "; data kept: userData " + (Test-Path (Join-Path $env:APPDATA 'usage-notch')) + ", captures " + (Test-Path (Join-Path $env:LOCALAPPDATA 'UsageNotch')))

# ---- reinstall, then uninstall deleting the data (a script's --delete-app-data,
# the same flag the question's default sets) ----------------------------------
Start-Process (Join-Path $in 'setup.exe') -ArgumentList '/S' -Wait | Out-Null
Start-Process $exe
Start-Sleep -Seconds 8
New-Item -ItemType Directory -Force (Join-Path $env:LOCALAPPDATA 'UsageNotch') | Out-Null
Set-Content (Join-Path $env:LOCALAPPDATA 'UsageNotch\probe.json') '{}'
$t3 = Get-Date
$u = Start-Process $un -ArgumentList '/currentuser', '/S', '--delete-app-data' -Wait -PassThru
Start-Sleep -Seconds 6
Say ("uninstall (delete data) exit {0} in {1:N1}s" -f $u.ExitCode, ((Get-Date) - $t3).TotalSeconds)
Say ("userData left: " + (Test-Path (Join-Path $env:APPDATA 'usage-notch')))
Say "processes after uninstall: $(@(Get-Process -Name 'Usage Notch' -ErrorAction SilentlyContinue).Count)"
Say "install dir left: $(Test-Path $instDir)"
Tree 'userData after uninstall' (Join-Path $env:APPDATA 'usage-notch')
Say ("LocalAppData UsageNotch left: " + (Test-Path (Join-Path $env:LOCALAPPDATA 'UsageNotch')))
Say ("Run key left: " + [bool]((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -like '*sage*' }))
Say ("start menu shortcut left: " + (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Usage Notch.lnk')))
Shot '5-after-uninstall'
Say 'DONE'
