# Clean-machine UPGRADE test, "Usage Notch" -> "LimitPeek", run INSIDE Windows
# Sandbox. Started by start.ps1 -Upgrade, which maps these two folders in:
# Input (read-only): C:\UsageNotchTest\in  -> old-setup.exe, new-setup.exe, this script
# Output (writable): C:\UsageNotchTest\out -> report.txt
#
# What every existing user does once: the old build installed and run (so its
# userData and its HKCU Run value exist), then the new installer over it. It
# must keep the data, keep the user's autostart choice under the new Run value
# name, and leave no old-named exe, shortcut or Run value behind.
$ErrorActionPreference = 'Continue'
$in = 'C:\UsageNotchTest\in'
$out = 'C:\UsageNotchTest\out'
$report = Join-Path $out 'report.txt'
function Say($s) { $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $s; Add-Content -Path $report -Value $line -Encoding UTF8 }
Set-Content -Path $report -Value "LimitPeek clean-machine UPGRADE test" -Encoding UTF8

$instDir = Join-Path $env:LOCALAPPDATA 'Programs\usage-notch'
$userData = Join-Path $env:APPDATA 'usage-notch'
$oldExe = Join-Path $instDir 'Usage Notch.exe'
$newExe = Join-Path $instDir 'LimitPeek.exe'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$apprKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$oldName = 'electron.app.Usage Notch'
$newName = 'electron.app.LimitPeek'
$marker = Join-Path $userData 'upgrade-marker.txt'
$lnks = [ordered]@{
  'start menu Usage Notch.lnk' = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Usage Notch.lnk')
  'start menu LimitPeek.lnk'   = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LimitPeek.lnk')
  'desktop Usage Notch.lnk'    = (Join-Path $env:USERPROFILE 'Desktop\Usage Notch.lnk')
  'desktop LimitPeek.lnk'      = (Join-Path $env:USERPROFILE 'Desktop\LimitPeek.lnk')
}

function RunValues($label) {
  foreach ($n in $oldName, $newName) {
    $v = (Get-ItemProperty -LiteralPath $runKey -Name $n -ErrorAction SilentlyContinue).$n
    $a = (Get-ItemProperty -LiteralPath $apprKey -Name $n -ErrorAction SilentlyContinue).$n
    $ah = if ($a) { ($a | ForEach-Object { $_.ToString('x2') }) -join '' } else { '-' }
    Say ("  [$label] Run '{0}': {1} | StartupApproved: {2}" -f $n, $(if ($null -ne $v) { $v } else { '(absent)' }), $ah)
  }
}
function Shortcuts($label) {
  foreach ($k in $lnks.Keys) {
    $p = $lnks[$k]
    $t = ''
    if (Test-Path -LiteralPath $p) { $t = ' -> ' + (New-Object -ComObject WScript.Shell).CreateShortcut($p).TargetPath }
    Say ("  [$label] {0}: {1}{2}" -f $k, (Test-Path -LiteralPath $p), $t)
  }
}
function Entry($label) {
  $e = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like 'Usage Notch*' -or $_.DisplayName -like 'LimitPeek*' })
  Say ("  [$label] Programs entries: " + $e.Count)
  foreach ($x in $e) {
    Say ("  [$label]   key={0} DisplayName='{1}' DisplayVersion={2}" -f $x.PSChildName, $x.DisplayName, $x.DisplayVersion)
    Say ("  [$label]   UninstallString={0}" -f $x.UninstallString)
    Say ("  [$label]   QuietUninstallString={0}" -f $x.QuietUninstallString)
  }
}
function InstFiles($label) {
  if (Test-Path $instDir) {
    $f = Get-ChildItem $instDir -File | ForEach-Object { $_.Name }
    Say ("  [$label] install dir files: " + ($f -join ', '))
  } else { Say "  [$label] install dir absent" }
}
function Procs($label) {
  $o = @(Get-Process -Name 'Usage Notch' -ErrorAction SilentlyContinue).Count
  $n = @(Get-Process -Name 'LimitPeek' -ErrorAction SilentlyContinue).Count
  Say "  [$label] processes: Usage Notch=$o LimitPeek=$n"
}
function StopApp {
  Get-Process -Name 'Usage Notch', 'LimitPeek' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}
function Hex12([byte]$first) { $b = New-Object byte[] 12; $b[0] = $first; return ,$b }

Say ("Windows: " + (Get-CimInstance Win32_OperatingSystem).Caption + " " + [Environment]::OSVersion.Version)
Say ("old installer: " + (Get-Item (Join-Path $in 'old-setup.exe')).VersionInfo.ProductVersion + "  new installer: " + (Get-Item (Join-Path $in 'new-setup.exe')).VersionInfo.ProductVersion)
Start-Sleep -Seconds 5

# ---- 1. the old build, installed and run once --------------------------------
$t = Get-Date
$p = Start-Process (Join-Path $in 'old-setup.exe') -ArgumentList '/S' -Wait -PassThru
Say ("OLD install exit {0} in {1:N1}s" -f $p.ExitCode, ((Get-Date) - $t).TotalSeconds)
Start-Sleep -Seconds 3
InstFiles 'old'
Say ("  [old] exe version: " + (Get-Item $oldExe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion)
Shortcuts 'old'
Entry 'old'
Start-Process $oldExe
Start-Sleep -Seconds 20
Procs 'old running'
RunValues 'old running'
Say ("  [old] userData exists: " + (Test-Path $userData) + "  settings.json: " + (Test-Path (Join-Path $userData 'settings.json')))
Set-Content -Path $marker -Value ("written while the old build was installed, " + (Get-Date).ToString('o')) -Encoding UTF8
Say ("  [old] marker written: " + (Test-Path $marker))
# The user switched it off in Task Manager: Windows writes this under the SAME
# value name, first byte 03 = disabled. The upgrade must keep it off.
if (-not (Test-Path $apprKey)) { New-Item -Path $apprKey -Force | Out-Null }
Set-ItemProperty -LiteralPath $apprKey -Name $oldName -Value (Hex12 3) -Type Binary
RunValues 'old, switched off in Task Manager'

# ---- 2. the new installer over it, silently, with the old app running -------
$before = Get-Date
Start-Sleep -Seconds 2
$t = Get-Date
$p = Start-Process (Join-Path $in 'new-setup.exe') -ArgumentList '/S' -Wait -PassThru
Say ("NEW install (upgrade) exit {0} in {1:N1}s" -f $p.ExitCode, ((Get-Date) - $t).TotalSeconds)
Start-Sleep -Seconds 3
Procs 'after upgrade'
InstFiles 'after upgrade'
Say ("  [after upgrade] exe version: " + (Get-Item $newExe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion)
Shortcuts 'after upgrade'
Entry 'after upgrade'
RunValues 'after upgrade, before first launch'
Say ("  [after upgrade] marker still present: " + (Test-Path $marker))

# ---- 3. the first LimitPeek launch --------------------------------------------
Start-Process $newExe
Start-Sleep -Seconds 20
Procs 'LimitPeek running'
RunValues 'LimitPeek running'
Say ("  [LimitPeek running] marker still present: " + (Test-Path $marker))
$touched = @(Get-ChildItem $userData -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $before })
Say ("  [LimitPeek running] userData files written since the upgrade: " + $touched.Count + " e.g. " + (($touched | Select-Object -First 6 | ForEach-Object { $_.FullName.Substring($userData.Length) }) -join ', '))
$s = Join-Path $userData 'settings.json'
if (Test-Path $s) { Say ("  [LimitPeek running] settings.json mtime " + (Get-Item $s).LastWriteTime.ToString('HH:mm:ss') + ": " + (Get-Content $s -Raw)) }
foreach ($d in 'LimitPeek', 'Usage Notch') { Say ("  [LimitPeek running] %APPDATA%\$d exists (must be False): " + (Test-Path (Join-Path $env:APPDATA $d))) }
$tcp = Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in @((Get-Process -Name 'LimitPeek' -ErrorAction SilentlyContinue).Id) }
Say ("  [LimitPeek running] TCP connections owned by the app: " + @($tcp).Count)

# ---- 4. the same move for a user who left autostart ON -------------------------
# An old install's value as it was, never switched off in Task Manager.
StopApp
Remove-ItemProperty -LiteralPath $runKey -Name $newName -ErrorAction SilentlyContinue
Remove-ItemProperty -LiteralPath $apprKey -Name $newName -ErrorAction SilentlyContinue
Set-ItemProperty -LiteralPath $runKey -Name $oldName -Value ('"' + $oldExe + '" --hidden') -Type String
RunValues 'seeded: old value, autostart on'
Start-Process $newExe
Start-Sleep -Seconds 15
RunValues 'LimitPeek launch, autostart on'

# ---- 5. a second update (LimitPeek over LimitPeek), then Windows "Kaldir" -------
$t = Get-Date
$p = Start-Process (Join-Path $in 'new-setup.exe') -ArgumentList '/S' -Wait -PassThru
Say ("UPDATE LimitPeek over itself: exit {0} in {1:N1}s, exe present: {2}" -f $p.ExitCode, ((Get-Date) - $t).TotalSeconds, (Test-Path $newExe))
InstFiles 'after self-update'
Start-Process $newExe
Start-Sleep -Seconds 8
$entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'LimitPeek*' } | Select-Object -First 1
Say ("UninstallString: " + $entry.UninstallString)
$un = Join-Path $instDir 'Uninstall LimitPeek.exe'
Say ("uninstaller the entry names exists: " + (Test-Path $un))
$t2 = Get-Date
Start-Process $un -ArgumentList '/currentuser', '/S', '--ask' | Out-Null
$prompt = $null
for ($i = 0; $i -lt 45 -and -not $prompt; $i++) {
  Start-Sleep -Seconds 1
  $prompt = Get-Process -Name 'LimitPeek' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*kald*' -or $_.MainWindowTitle -like '*Uninstall*' }
}
Say ("uninstall prompt window after {0}s: {1} {2}" -f ((Get-Date) - $t2).TotalSeconds.ToString('N0'), @($prompt).Count, (($prompt | ForEach-Object { '"' + $_.MainWindowTitle + '"' }) -join ', '))
$prompt | Stop-Process -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 60 -and (Test-Path $newExe); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 4
Say ("uninstall (prompt closed = keep data) done in {0:N1}s" -f ((Get-Date) - $t2).TotalSeconds)
Say ("  app removed: " + (-not (Test-Path $newExe)) + "; install dir left: " + (Test-Path $instDir) + "; marker kept: " + (Test-Path $marker))
RunValues 'after uninstall'
Shortcuts 'after uninstall'
Entry 'after uninstall'
Procs 'after uninstall'
Say 'DONE'
