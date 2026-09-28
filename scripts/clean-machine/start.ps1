# Clean-machine first-run test: installs the newest dist\ installer in a fresh
# Windows Sandbox with networking OFF, runs run-test.ps1 inside it, and leaves
# a report and screenshots in %TEMP%\usage-notch-clean-machine\out.
#
#   powershell -ExecutionPolicy Bypass -File scripts\clean-machine\start.ps1
#
# Needs the Windows feature "Windows Sandbox" (Containers-DisposableClientVM).
# Nothing on the host is touched: the sandbox is discarded when its window closes.
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$setup = Get-ChildItem (Join-Path $repo 'dist') -Filter 'Usage Notch Setup *.exe' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'No installer in dist\. Run npm run dist first.' }

$sandboxExe = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not (Test-Path $sandboxExe)) { throw 'Windows Sandbox is not enabled (or the PC was not restarted after enabling it).' }

$work = Join-Path $env:TEMP 'usage-notch-clean-machine'
$in = Join-Path $work 'in'
$out = Join-Path $work 'out'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $in, $out | Out-Null
Copy-Item $setup.FullName (Join-Path $in 'setup.exe')
Copy-Item (Join-Path $PSScriptRoot 'run-test.ps1') $in

$wsb = @"
<Configuration>
  <Networking>Disable</Networking>
  <vGPU>Disable</vGPU>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$in</HostFolder>
      <SandboxFolder>C:\UsageNotchTest\in</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$out</HostFolder>
      <SandboxFolder>C:\UsageNotchTest\out</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\UsageNotchTest\in\run-test.ps1</Command>
  </LogonCommand>
</Configuration>
"@
$wsbPath = Join-Path $work 'usage-notch-test.wsb'
Set-Content -Path $wsbPath -Value $wsb -Encoding UTF8
"installer: $($setup.Name)"
"report:    $out\report.txt"
Start-Process $wsbPath
