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
function Shot($name) {
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
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

# A second launch opens the panel (second-instance -> openPanel).
Start-Process $exe
Start-Sleep -Seconds 6
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

# ---- uninstall ---------------------------------------------------------------
$un = Join-Path $instDir 'Uninstall Usage Notch.exe'
Say "uninstaller present: $(Test-Path $un)"
if (Test-Path $un) {
  $t2 = Get-Date
  $u = Start-Process $un -ArgumentList '/S' -Wait -PassThru
  Say ("uninstall exit {0} in {1:N1}s" -f $u.ExitCode, ((Get-Date) - $t2).TotalSeconds)
  Start-Sleep -Seconds 8
}
Say "processes after uninstall: $(@(Get-Process -Name 'Usage Notch' -ErrorAction SilentlyContinue).Count)"
Say "install dir left: $(Test-Path $instDir)"
Tree 'userData after uninstall' (Join-Path $env:APPDATA 'usage-notch')
Say ("LocalAppData UsageNotch left: " + (Test-Path (Join-Path $env:LOCALAPPDATA 'UsageNotch')))
Say ("Run key left: " + [bool]((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -like '*sage*' }))
Say ("start menu shortcut left: " + (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Usage Notch.lnk')))
Shot '5-after-uninstall'
Say 'DONE'
