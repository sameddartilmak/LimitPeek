<#
.SYNOPSIS
  OS-level proof that the packaged app opens no socket of its own (ADR-001 F11,
  ADR-003 Amendment 5 K25).

.DESCRIPTION
  Every other F11 test in this repo asserts from INSIDE the process: no HTTP
  client in the dependency tree, defaultSession cancels every request, the keyed
  session's allowlist refuses every hostile URL shape. None of that can see a
  socket opened by Chromium itself, by a child process, or by anything that
  bypasses Electron's request filters. This script watches from outside, at the
  kernel, and is the only evidence K25 accepts.

  HOW IT WATCHES
    An ETW session on `Microsoft-Windows-Kernel-Network` (provider
    {7dd42a49-5329-4832-8dfd-43d979153a88}). That provider emits one event per
    TCP connect / accept / send / receive / retransmit and per UDP datagram,
    IPv4 and IPv6, each carrying the owning PID and both endpoints. It sees
    short-lived connections that a polling sampler would miss, and it costs no
    persistent machine configuration: the session is created, then deleted.

    Deliberately NOT the Windows Filtering Platform audit (Security 5156/5157).
    That needs `auditpol /set /subcategory:"Filtering Platform Connection"
    /success:enable`, which is a machine-wide policy change that writes one
    Security event per connection FOR EVERY PROCESS. On a developer workstation
    (20 MB Security log) a ten-minute window overflows the log and destroys
    existing audit history. If an auditor requires 5156 specifically, that is a
    human decision, run deliberately, and the log should be enlarged first:

      auditpol /backup /file:audit-before.csv
      wevtutil sl Security /ms:536870912
      auditpol /set /subcategory:"Filtering Platform Connection" /success:enable
      ... run this script with -SkipEtw ...
      auditpol /restore /file:audit-before.csv

    A second, elevation-free channel runs alongside: `Get-NetTCPConnection` and
    `Get-NetUDPEndpoint` sampled per PID. It is a cross-check, not the evidence —
    it cannot see a connection that opens and closes between two samples.

  WHAT IS ISOLATED, AND WHAT IS NOT
    The app runs from -AppDir with its own `--user-data-dir`, so settings.json,
    the single-instance lock and the window state are the audit's, not the
    owner's. The API key is NOT in userData by design (src/core/paths.js:135:
    %LOCALAPPDATA%\UsageNotch\secrets), so a real key WOULD be visible to this
    run. Case A therefore refuses to start if a secret record exists.

    A packaged launch rewrites HKCU\...\Run (src/main/index.js:486
    applyAutostart, packaged builds only). The value is read before launch and
    written back verbatim in the finally block, including the case where it did
    not exist.

  THE THREE CASES
    -Case A   No key stored. Asserts ZERO kernel-network events of ANY kind -
              loopback included - from any PID of the app's process tree, and
              zero sockets in the sampler. Loopback counts because the WPAD
              defect this script was written for produced 32 TCPv4 attempts to
              127.0.0.1:80 fetching wpad.dat beside its DNS; a criterion of
              "non-loopback only" would have passed a regression that resolves
              `wpad` to a loopback proxy. Runnable here.
    -Case B   A real key stored (owner only; needs a fine-grained GitHub PAT).
              Asserts that every non-loopback event is either UDP/53 to a
              configured DNS server or TCP/443 to an address currently resolved
              for the allowlisted host (src/core/keys/registry.js:83
              api.github.com), that no other remote endpoint appears at all, and
              that the number of distinct TCP/443 connection attempts is at most
              ceil(Minutes / 5) + 1 — the MIN_GAP_MS floor of
              src/core/keys/schedule.js:37 plus the one request at startup.
    -Case C   Starts with a key stored, waits for the secret record to disappear
              (the owner removes the key from the panel), then asserts ZERO
              non-loopback events after the removal timestamp.

    A KNOWN LEGITIMATE WAY CASE B CAN FAIL, which must NOT be papered over:
    if the TLS handshake to api.github.com needs an intermediate certificate the
    machine does not have cached, Chromium fetches it over plain TCP/80 from the
    URL inside the server certificate (AIA), after a DNS lookup for that CA
    host. Neither is a URLRequest, so no allowlist in this app can see it, and
    Case B will FAIL and print `peer=<ip> ptr=<host>`. The correct response is to
    report that host and change the consent copy to say a certificate may be
    fetched from a certificate authority - NOT to add the host here. Online OCSP
    is not expected (Chromium uses CRLSets for non-EV certificates); that is
    upstream reading, not something this script has measured.

    B and C cannot be simulated without a real PAT: the app makes no request
    unless a DPAPI record it can decrypt exists, and this script will not
    fabricate one. Both are one command for the owner:

      powershell -ExecutionPolicy Bypass -File scripts\zero-socket-audit.ps1 -Case B -Minutes 35
      powershell -ExecutionPolicy Bypass -File scripts\zero-socket-audit.ps1 -Case C -Minutes 20

  FIRST MEASUREMENT (2026-09-22, Windows 11 26200, electron 44.2.0)
    Case A, 10 min, no key, dist\win-unpacked: FAIL.
      46 kernel-network events from the 4 app pids; 6 of them non-loopback, all
      within the first 0.87 s of launch, from the
      `--type=utility --utility-sub-type=network.mojom.NetworkService` child:
        4 x UDPv4 27 bytes -> 192.168.1.1:53   (the LAN resolver)
        2 x UDPv4 43 bytes <- 192.168.1.1:53
      = 108 bytes outbound with no key stored. The remaining 40 events are
      loopback: 32 TCPv4 reconnect attempts to 127.0.0.1:80 plus 8 closes.
      A Chromium net-log of the same build names the cause: queries for
      `wpad.home`, then `http://wpad/wpad.dat` - WPAD proxy auto-discovery,
      which is host resolution and a PAC fetch, NOT a URLRequest, so no
      `webRequest.onBeforeRequest` filter can see or cancel it.
      The polling sampler saw 0 non-loopback TCP in the same run: it would have
      reported a PASS. That is why this script is ETW-based.
    Same case, 5 min, -ExtraArgs '--no-proxy-server': PASS, 0 events of any kind.

  EXIT CODE
    0 = the case's assertion held. 1 = it did not, or a precondition failed.
    The full event list and a JSON summary are written to -OutDir.

  WHAT IT COSTS TO RUN
    The ETW session is machine-wide (the provider has no per-PID filter), so the
    .etl grows with EVERY process's network activity, not with the app's.
    Measured on a working developer box: ~5.5 MB/min, i.e. ~360 MB for a
    65-minute window, all of it in -OutDir under %TEMP%. Check free space before
    a long run and delete -OutDir afterwards. Parsing is proportional but cheap,
    because the PID filter is pushed into the native reader as XPath; the
    expensive part is materialising matched events, and a passing run matches
    none. Nothing is left behind on the machine: the session is deleted, the
    HKCU\Run value is restored verbatim, and every file lives under -OutDir.

  REQUIREMENTS
    Elevation (ETW session creation). An interactive desktop session: this
    launches a real tray application. `npm run dist:dir` must have been run.
#>
[CmdletBinding()]
param(
  [ValidateSet('A', 'B', 'C')]
  [string]$Case = 'A',

  [ValidateRange(1, 720)]
  [int]$Minutes = 10,

  # Empty means "the unpacked build this repo produces with `npm run dist:dir`".
  # Resolved below, not here: $PSScriptRoot is not bound yet inside param().
  [string]$AppDir = '',

  [string]$OutDir = (Join-Path $env:TEMP ('usage-notch-audit-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))),

  # Cross-check only, for a run where ETW is unavailable or a WFP audit is used.
  [switch]$SkipEtw,

  # Extra command-line switches for the app under audit, so a candidate fix can
  # be measured before it is committed. The first Case A run here failed on
  # Chromium's WPAD proxy auto-discovery (DNS for wpad.<suffix> plus a GET of
  # http://wpad/wpad.dat at startup, from the --type=utility NetworkService
  # child), and `-ExtraArgs '--no-proxy-server'` is how that was confirmed.
  [string[]]$ExtraArgs = @(),

  [ValidateRange(1, 60)]
  [int]$SampleSeconds = 2,

  # OFF by default, and it must stay that way unless a human asked for it.
  #
  # A static window cannot see traffic that is triggered by a network CHANGE
  # rather than by time: Chromium re-resolves proxy configuration and re-runs
  # host resolution on NetworkChangeNotifier events, which on Windows come from
  # NotifyAddrChange, not from a timer. Toggling an adapter once mid-window is
  # the only way to exercise that path.
  #
  # It is also the one thing this script does that changes the operator's own
  # machine: `Disable-NetAdapter` on the box's only adapter drops every
  # connection on it, including the one you may be reading this over. The
  # re-enable is in the finally block so an abort still restores it, but nothing
  # can protect a machine whose only route went away. Pass the adapter name
  # explicitly, on a machine you are sitting at:
  #
  #   Get-NetAdapter | Where-Object Status -eq 'Up'
  #   ... -ToggleAdapter 'Wi-Fi'
  [string]$ToggleAdapter = '',

  [ValidateRange(5, 120)]
  [int]$ToggleDownSeconds = 20
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SESSION = 'UsageNotchZeroSocket'
$RUN_KEY = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RUN_VALUE = 'electron.app.Usage Notch'
$SECRETS_DIR = Join-Path $env:LOCALAPPDATA 'UsageNotch\secrets'
$ALLOWED_HOST = 'api.github.com'
# Must match MIN_GAP_MS in src/core/keys/schedule.js (5 min since 2026-09-24).
$MIN_GAP_MINUTES = 5

function Say([string]$m) { Write-Host ("[audit] " + $m) }
function Fail([string]$m) { Write-Host ("[audit] FAIL " + $m) -ForegroundColor Red; exit 1 }

# --- preconditions -----------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $SkipEtw -and -not $isAdmin) {
  Fail "an ETW session needs elevation. Re-run elevated, or pass -SkipEtw to keep only the sampler (weaker evidence)."
}

if (-not $AppDir) { $AppDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\win-unpacked' }
$exe = Join-Path $AppDir 'Usage Notch.exe'
if (-not (Test-Path -LiteralPath $exe)) { Fail "no packaged exe at $exe - run 'npm run dist:dir' first." }
$exe = (Resolve-Path -LiteralPath $exe).Path

$secretRecords = @()
if (Test-Path -LiteralPath $SECRETS_DIR) {
  $secretRecords = @(Get-ChildItem -LiteralPath $SECRETS_DIR -Filter '*.json' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*.state.json' })
}
switch ($Case) {
  'A' {
    if ($secretRecords.Count -gt 0) {
      Fail ("Case A needs NO stored key, but " + $SECRETS_DIR + " holds: " +
        (($secretRecords | ForEach-Object { $_.Name }) -join ', ') +
        ". Remove the key from the panel first; this script will not touch it.")
    }
  }
  'B' {
    if ($secretRecords.Count -eq 0) {
      Fail ("Case B needs a real stored key. None in " + $SECRETS_DIR + ". Add one from the panel, then re-run. " +
        "This script cannot fabricate a key: without a decryptable DPAPI record the app makes no request and Case B would pass vacuously.")
    }
  }
  'C' {
    if ($secretRecords.Count -eq 0) {
      Fail ("Case C must START with a stored key so there is a request to stop. None in " + $SECRETS_DIR + ".")
    }
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$userData = Join-Path $OutDir 'user-data'
New-Item -ItemType Directory -Force -Path $userData | Out-Null
# A key is polled only while Copilot is in the panel (K16), and a fresh
# user-data-dir starts with it switched off. Without this seed Case B and C
# would see no request at all and pass for the wrong reason.
if ($Case -ne 'A') {
  [System.IO.File]::WriteAllText((Join-Path $userData 'settings.json'),
    '{"enabledProviders":{"copilot":true}}', (New-Object System.Text.UTF8Encoding($false)))
  # The key record is sealed with Electron safeStorage, whose key lives in
  # "Local State" INSIDE the user-data-dir. A fresh dir gets a fresh key, so the
  # audited app cannot open the record, answers 'unreadable' and sends nothing.
  # First Case B run (2026-09-24) measured exactly that: 0 events. The owner's
  # Local State is copied in for the run and deleted in the finally block.
  $ownerLocalState = Join-Path (Join-Path $env:APPDATA 'usage-notch') 'Local State'
  if (-not (Test-Path -LiteralPath $ownerLocalState)) { Fail "no Local State at $ownerLocalState; the stored key could not be opened" }
  Copy-Item -LiteralPath $ownerLocalState -Destination (Join-Path $userData 'Local State') -Force
}
$etl = Join-Path $OutDir 'kernel-network.etl'

Say "case=$Case minutes=$Minutes"
Say "exe=$exe"
Say "user-data-dir=$userData (separate: the owner's settings are untouched)"
Say "out=$OutDir"

# --- HKCU\Run: read the exact value, restore it whatever happens -------------

# A run that is KILLED (session ended, window closed, Ctrl+C at the wrong moment)
# never reaches its finally block, so the app's rewrite of this value survives
# it. The next run would then read that rewritten value as "before" and restore
# it faithfully -- which is exactly how the owner's login item ended up pointing
# at dist\win-unpacked on 2026-09-23. So the backup is persisted to a marker
# BEFORE the app is launched and removed only after the restore; finding one at
# start means an earlier run died holding the original, and it is put back first.
$RUN_MARKER = Join-Path $env:TEMP 'usage-notch-audit-run-key.json'
if (Test-Path -LiteralPath $RUN_MARKER) {
  $pending = Get-Content -LiteralPath $RUN_MARKER -Raw | ConvertFrom-Json
  if ($pending.existed) {
    Set-ItemProperty -LiteralPath $RUN_KEY -Name $RUN_VALUE -Value $pending.value -Type String
    Say ("HKCU\Run: an earlier run was interrupted before restoring; put back its original: " + $pending.value)
  } else {
    Remove-ItemProperty -LiteralPath $RUN_KEY -Name $RUN_VALUE -ErrorAction SilentlyContinue
    Say "HKCU\Run: an earlier run was interrupted before restoring; removed the value it had added."
  }
  Remove-Item -LiteralPath $RUN_MARKER -Force
}

$runBefore = $null
$runExisted = $false
try {
  $runBefore = (Get-ItemProperty -LiteralPath $RUN_KEY -Name $RUN_VALUE -ErrorAction Stop).$RUN_VALUE
  $runExisted = $true
  Say ("HKCU\Run backup: " + $runBefore)
} catch {
  Say "HKCU\Run has no Usage Notch value; it will be removed again after the run if the app adds one."
}
if ($runExisted -and $runBefore -like '*\dist\win-unpacked\*') {
  Say "WARNING: the HKCU\Run value already points at a dist\win-unpacked build. That is an audit leftover, not the owner's installed app; it will be restored as found, so fix it by relaunching the installed app afterwards."
}
@{ existed = $runExisted; value = $runBefore } | ConvertTo-Json | Set-Content -LiteralPath $RUN_MARKER -Encoding UTF8

$dnsServers = @(Get-DnsClientServerAddress -ErrorAction SilentlyContinue |
  ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique)
$allowedIps = @()
if ($Case -ne 'A') {
  $allowedIps = @(Resolve-DnsName -Name $ALLOWED_HOST -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress } | Sort-Object -Unique)
  Say ("allowlisted host " + $ALLOWED_HOST + " resolves to: " + ($allowedIps -join ', '))
}

$pids = [System.Collections.Generic.HashSet[int]]::new()
# Identity of every pid ever tracked, recorded the moment it is discovered. A
# pid alone is not evidence: Windows reuses them, and an offending event has to
# be attributable to a named image before it counts against the app.
$pidInfo = @{}
$samples = New-Object System.Collections.ArrayList
$removalAt = $null
$root = $null
$toggleDone = $false
$toggleStartedAt = $null
$toggleEndedAt = $null
$deadAt = $null
$aliveTicks = 0
$buffersLost = -1
$buffersWritten = -1
# Chromium child roles seen over the window. A `renderer` here means a document
# was actually loaded, i.e. the panel exists and the measurement is of a working
# app rather than of a process that came up and did nothing.
$childRoles = [System.Collections.Generic.HashSet[string]]::new()

function Register-Pid([int]$id, [string]$why) {
  if ($pidInfo.ContainsKey($id)) { return }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  $pidInfo[$id] = [pscustomobject]@{
    pid = $id; why = $why
    name = $(if ($p) { $p.Name } else { '(gone)' })
    exe = $(if ($p) { $p.ExecutablePath } else { $null })
    parent = $(if ($p) { [int]$p.ParentProcessId } else { 0 })
    ours = $(if ($p) { $p.ExecutablePath -eq $exe } else { $false })
    commandLine = $(if ($p) { $p.CommandLine } else { $null })
  }
  $null = $pids.Add($id)
  $cl = $pidInfo[$id].commandLine
  $role = 'browser'
  if ($cl -and $cl -match '--type=([a-z\-]+)') { $role = $Matches[1] }
  if ($cl -and $cl -match '--utility-sub-type=([^\s]+)') { $role = $role + ':' + $Matches[1] }
  $null = $childRoles.Add($role)
  Say ("pid " + $id + " (" + $why + ", " + $role + "): " + $pidInfo[$id].name)
}

try {
  # --- ETW session ----------------------------------------------------------
  if (-not $SkipEtw) {
    logman stop $SESSION -ets 2>$null | Out-Null
    logman delete $SESSION -ets 2>$null | Out-Null
    # 0xffffffffffffffff/0xff: both keywords (IPV4 0x10, IPV6 0x20) at every
    # level. Small buffers keep the file close to the real event volume.
    logman create trace $SESSION -p 'Microsoft-Windows-Kernel-Network' 0xffffffffffffffff 0xff `
      -o $etl -ets -bs 8 -nb 16 128 -max 0 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "could not start the ETW session (exit $LASTEXITCODE)." }
    Say "ETW session $SESSION started -> $etl"
  }

  $startedAt = Get-Date
  $appArgs = @("--user-data-dir=$userData") + $ExtraArgs
  Say ("args: " + ($appArgs -join ' '))
  $proc = Start-Process -FilePath $exe -ArgumentList $appArgs -PassThru
  $root = $proc.Id
  Say ("launched pid=" + $root + " at " + $startedAt.ToString('o'))
  Register-Pid $root 'root'

  # --- watch ----------------------------------------------------------------
  $deadline = $startedAt.AddMinutes($Minutes)
  $toggleAt = $startedAt.AddMinutes($Minutes / 2)
  while ((Get-Date) -lt $deadline) {
    # One network-change event, halfway through, only if a human named an
    # adapter. See the -ToggleAdapter comment: this is the only line in the
    # script that changes the operator's machine.
    if ($ToggleAdapter -and -not $toggleDone -and (Get-Date) -ge $toggleAt) {
      $toggleDone = $true
      $toggleStartedAt = Get-Date
      Say ("toggling adapter '" + $ToggleAdapter + "' down for " + $ToggleDownSeconds + " s at " + $toggleStartedAt.ToString('o'))
      Disable-NetAdapter -Name $ToggleAdapter -Confirm:$false -ErrorAction Stop
      Start-Sleep -Seconds $ToggleDownSeconds
      Enable-NetAdapter -Name $ToggleAdapter -Confirm:$false -ErrorAction Stop
      $toggleEndedAt = Get-Date
      Say ("adapter re-enabled at " + $toggleEndedAt.ToString('o'))
    }
    # Every process of the tree runs the SAME exe, so identity by ExecutablePath
    # catches the GPU, utility and renderer children without walking parents -
    # and cannot pick up the INSTALLED build, whose path differs.
    $live = @(Get-CimInstance Win32_Process -Filter "Name = 'Usage Notch.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -eq $exe })
    foreach ($p in $live) { Register-Pid ([int]$p.ProcessId) 'same-exe' }
    # Anything the app spawns that is NOT our exe (e.g. the Antigravity CLI
    # helper via execFile) is picked up as a descendant of a known pid.
    $others = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -and $pids.Contains([int]$_.ParentProcessId) })
    foreach ($p in $others) { Register-Pid ([int]$p.ProcessId) 'child-of-tracked' }

    foreach ($id in @($pids)) {
      foreach ($c in @(Get-NetTCPConnection -OwningProcess $id -ErrorAction SilentlyContinue)) {
        $null = $samples.Add([pscustomobject]@{
          at = (Get-Date).ToString('o'); kind = 'tcp'; pid = $id
          local = ($c.LocalAddress + ':' + $c.LocalPort)
          remote = ($c.RemoteAddress + ':' + $c.RemotePort)
          state = [string]$c.State
        })
      }
      foreach ($u in @(Get-NetUDPEndpoint -OwningProcess $id -ErrorAction SilentlyContinue)) {
        $null = $samples.Add([pscustomobject]@{
          at = (Get-Date).ToString('o'); kind = 'udp'; pid = $id
          local = ($u.LocalAddress + ':' + $u.LocalPort)
          remote = '-'; state = 'bound'
        })
      }
    }

    if ($Case -eq 'C' -and -not $removalAt) {
      $still = @(Get-ChildItem -LiteralPath $SECRETS_DIR -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '*.state.json' })
      if ($still.Count -eq 0) {
        $removalAt = Get-Date
        Say ("key removed at " + $removalAt.ToString('o') + "; everything after this instant must be silent.")
      }
    }

    if (-not (Get-Process -Id $root -ErrorAction SilentlyContinue)) {
      # A window the app did not survive proves nothing: zero events out of a
      # dead process is a false PASS of exactly the kind this script exists to
      # prevent. Recorded here and turned into a FAIL below.
      $deadAt = Get-Date
      Say ("the app exited at " + $deadAt.ToString('o') + ", before the window closed; stopping here.")
      break
    }
    $aliveTicks++
    Start-Sleep -Seconds $SampleSeconds
  }
  $endedAt = Get-Date
  Say ("window closed at " + $endedAt.ToString('o') + "; pids seen: " + (($pids | Sort-Object) -join ', '))
}
finally {
  # Before anything else: never leave the operator's adapter down, whatever
  # aborted the run.
  if ($ToggleAdapter) {
    $a = Get-NetAdapter -Name $ToggleAdapter -ErrorAction SilentlyContinue
    if ($a -and $a.Status -eq 'Disabled') {
      Enable-NetAdapter -Name $ToggleAdapter -Confirm:$false -ErrorAction SilentlyContinue
      Say ("adapter '" + $ToggleAdapter + "' was still down; re-enabled in the finally block.")
    }
  }
  foreach ($id in @($pids)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    # Only ever our own unpacked exe: never the installed build, never anything else.
    if ($p -and $p.ExecutablePath -eq $exe) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  }
  if ($Case -ne 'A') {
    # The copied key wrapper is not left lying in %TEMP%.
    Start-Sleep -Milliseconds 500
    Remove-Item -LiteralPath (Join-Path $userData 'Local State') -Force -ErrorAction SilentlyContinue
  }
  if (-not $SkipEtw) {
    # Read the session's own counters BEFORE stopping it: a dropped buffer could
    # have contained exactly the event this run is looking for, so a lossy
    # capture cannot prove zero and is failed below rather than reported as PASS.
    $q = (logman query $SESSION -ets 2>&1) -join "`n"
    $m = [regex]::Match($q, 'Buffers Lost:\s+(\d+)')
    if ($m.Success) { $buffersLost = [int]$m.Groups[1].Value }
    $m = [regex]::Match($q, 'Buffers Written:\s+(\d+)')
    if ($m.Success) { $buffersWritten = [int]$m.Groups[1].Value }
    Say ("ETW buffers written=" + $buffersWritten + " lost=" + $buffersLost)

    logman stop $SESSION -ets 2>$null | Out-Null
    logman delete $SESSION -ets 2>$null | Out-Null
    Say "ETW session stopped and deleted (no persistent machine change)."
  }
  if ($runExisted) {
    Set-ItemProperty -LiteralPath $RUN_KEY -Name $RUN_VALUE -Value $runBefore -Type String
    Say ("HKCU\Run restored: " + (Get-ItemProperty -LiteralPath $RUN_KEY -Name $RUN_VALUE).$RUN_VALUE)
  } else {
    Remove-ItemProperty -LiteralPath $RUN_KEY -Name $RUN_VALUE -ErrorAction SilentlyContinue
    Say "HKCU\Run left with no Usage Notch value, as before the run."
  }
  # Restored: the marker has done its job. Removed LAST, so a failure above
  # leaves it in place for the next run to recover from.
  Remove-Item -LiteralPath $RUN_MARKER -Force -ErrorAction SilentlyContinue
}

# --- parse -------------------------------------------------------------------

function Format-Addr($value) {
  if ($null -eq $value) { return '?' }
  if ($value -is [byte[]]) {
    if ($value.Length -eq 4) { return ($value -join '.') }
    return ([System.Net.IPAddress]::new($value)).ToString()
  }
  $v = [uint32]$value
  # The provider stores an in_addr, so the first octet is the low byte.
  return ('{0}.{1}.{2}.{3}' -f ($v -band 255), (($v -shr 8) -band 255), (($v -shr 16) -band 255), (($v -shr 24) -band 255))
}

# The provider stores ports in NETWORK byte order: a raw `13568` is 0x3500, i.e.
# port 53. Windows' own rendered message shows the swapped value, so the two
# disagreed until this was applied - verified against
# "UDPv4: 27 bytes transmitted from 192.168.1.208:55285 to 192.168.1.1:53."
function Format-Port($value) {
  if ($null -eq $value) { return '?' }
  $v = [int]$value
  return ((($v -band 255) -shl 8) -bor (($v -shr 8) -band 255))
}

function Test-Loopback([string]$a) {
  if (-not $a) { return $true }
  return ($a -eq '::1' -or $a -eq '::' -or $a -eq '0.0.0.0' -or $a -like '127.*')
}

$events = New-Object System.Collections.ArrayList
if (-not $SkipEtw) {
  $files = @(Get-ChildItem -LiteralPath $OutDir -Filter '*.etl' -File)
  if ($files.Count -eq 0) { Fail "the ETW session produced no .etl file." }
  # The PID filter is pushed into the native reader: on a busy machine the file
  # holds millions of events and only a handful can be ours.
  $clauses = @($pids | ForEach-Object { "System[Execution[@ProcessID=$_]]" })
  $clauses += @($pids | ForEach-Object { "EventData[Data[@Name='PID']='$_']" })
  $xpath = '*[' + ($clauses -join ' or ') + ']'

  # POSITIVE CONTROL. This script's whole verdict is "the filtered read returned
  # nothing", and that is the shape of assertion that fails silently forever: a
  # malformed XPath, a provider that never fired, an .etl the reader cannot open,
  # or a swallowed error all produce zero events and therefore a PASS. Nothing
  # about the filter's own text would notice.
  #
  # So before trusting a zero, prove the pipeline can return non-zero: read ONE
  # event with no filter at all. The session is machine-wide, so on any machine
  # with a network stack this must succeed. If it does not, the run is void
  # rather than green.
  $control = $null
  try {
    $control = Get-WinEvent -Path $files[0].FullName -Oldest -MaxEvents 1 -ErrorAction Stop
  } catch {
    Fail ("the .etl could not be read at all (" + $_.Exception.Message + "); a zero from this run would be meaningless.")
  }
  if (-not $control) {
    Fail "the .etl parsed but holds no events of any kind. The provider never fired or the capture is broken; a zero here is not evidence."
  }
  Say ("positive control: the reader returned an event (id " + $control.Id + "), so a zero below is a real zero.")

  foreach ($f in $files) {
    Say ("parsing " + $f.Name + " (" + [math]::Round($f.Length / 1MB, 1) + " MB)")
    # -ErrorAction Stop, NOT SilentlyContinue: "no matching events" is not an
    # error here, but a BAD XPATH is, and swallowing it would turn a broken
    # filter into a permanent PASS.
    $matched = @()
    try {
      $matched = @(Get-WinEvent -Path $f.FullName -Oldest -FilterXPath $xpath -ErrorAction Stop)
    } catch {
      # Get-WinEvent THROWS when a filter matches nothing, so this branch is on
      # the normal, passing path and must not be mistaken for a failure.
      #
      # Discriminated by FullyQualifiedErrorId, never by the message text:
      # `NoMatchingEventsFound` is a stable identifier, while "No events were
      # found..." is localised and would stop matching on a non-English Windows -
      # turning every clean run into a false FAIL, and being exactly the kind of
      # pattern that quietly stops matching. A malformed XPath arrives here as
      # EventLogException instead and is a real failure.
      if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {
        $matched = @()
      } else {
        Fail ("the PID filter could not be applied (" + $_.FullyQualifiedErrorId + "); xpath was: " + $xpath)
      }
    }
    foreach ($e in $matched) {
      $x = [xml]$e.ToXml()
      $d = @{}
      foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
      $src = Format-Addr $d['saddr']; $dst = Format-Addr $d['daddr']
      $owner = [int]$d['PID']
      $null = $events.Add([pscustomobject]@{
        at = $e.TimeCreated.ToString('o'); id = $e.Id; pid = $owner
        image = $(if ($pidInfo.ContainsKey($owner)) { $pidInfo[$owner].name } else { '(untracked)' })
        ours = $(if ($pidInfo.ContainsKey($owner)) { $pidInfo[$owner].ours } else { $false })
        proto = $(if ($e.Id -ge 42) { 'udp' } else { 'tcp' })
        saddr = $src; sport = (Format-Port $d['sport'])
        daddr = $dst; dport = (Format-Port $d['dport'])
        size = $d['size']
        loopback = ((Test-Loopback $src) -and (Test-Loopback $dst))
        message = $e.Message
      })
    }
  }
}

$offenders = @($events | Where-Object { -not $_.loopback })
# `ConvertTo-Json` on an empty collection emits nothing, which leaves NO FILE -
# and "the evidence file is missing" reads the same as "nobody ran it". An empty
# capture is the result we want, so it has to be written down as `[]`.
function Write-Json($value, [string]$path) {
  $json = @($value) | ConvertTo-Json -Depth 4
  if ([string]::IsNullOrWhiteSpace($json)) { $json = '[]' }
  Set-Content -Encoding UTF8 -Path $path -Value $json
}
Write-Json $samples (Join-Path $OutDir 'samples.json')
Write-Json $events (Join-Path $OutDir 'kernel-network-events.json')

$sampledRemote = @($samples | Where-Object {
  $_.kind -eq 'tcp' -and -not (Test-Loopback (($_.remote -split ':')[0]))
})

Say ("ETW events for our pids: " + $events.Count + " (non-loopback: " + $offenders.Count + ")")
Say ("sampler rows: " + $samples.Count + " (non-loopback tcp: " + $sampledRemote.Count + ")")

$verdict = 'PASS'
$reasons = New-Object System.Collections.ArrayList

# Liveness first, for every case. Zero traffic from an app that died in minute
# two is not evidence of anything.
if ($deadAt) {
  $verdict = 'FAIL'
  $null = $reasons.Add("the app exited at $($deadAt.ToString('o')), before the $Minutes-minute window closed; the measurement is void")
}
if (-not $SkipEtw -and $buffersLost -ne 0) {
  $verdict = 'FAIL'
  $null = $reasons.Add("ETW reported $buffersLost lost buffers (written $buffersWritten); a capture with a gap cannot prove zero. Re-run with larger buffers: -bs 64 -nb 64 256")
}
if (-not $childRoles.Contains('renderer')) {
  $verdict = 'FAIL'
  $null = $reasons.Add("no renderer child process ever appeared (roles seen: $(($childRoles | Sort-Object) -join ', ')); the panel document never loaded, so this is not a working app")
}

switch ($Case) {
  'A' {
    # ZERO events of ANY kind, loopback included. "Non-loopback only" was the
    # first criterion here and it was too loose: the WPAD defect this script was
    # written to catch produced 32 TCPv4 attempts to 127.0.0.1:80 fetching
    # wpad.dat alongside its 6 DNS datagrams, so a regression in which `wpad`
    # resolves to a loopback proxy would have PASSED. With no key stored the app
    # has no business opening any socket at all, and the --no-proxy-server
    # control run measured 0 of any kind, so the tighter bar costs nothing.
    if ($events.Count -gt 0) {
      $verdict = 'FAIL'
      $null = $reasons.Add("$($events.Count) kernel-network events with no key stored ($($offenders.Count) of them non-loopback); expected 0 of any kind")
    }
    if ($samples.Count -gt 0) {
      $verdict = 'FAIL'
      $null = $reasons.Add("$($samples.Count) sockets seen by the sampler ($($sampledRemote.Count) non-loopback tcp); expected 0")
    }
  }
  'B' {
    $budget = [math]::Ceiling($Minutes / $MIN_GAP_MINUTES) + 1
    $connects = @($offenders | Where-Object { $_.id -in 12, 28 })
    foreach ($o in $offenders) {
      $peer = if (Test-Loopback $o.saddr) { $o.daddr } elseif (Test-Loopback $o.daddr) { $o.saddr } else { $o.daddr }
      $okDns = ($o.proto -eq 'udp' -and ($o.dport -eq '53' -or $o.sport -eq '53') -and ($dnsServers -contains $peer -or $dnsServers -contains $o.saddr -or $dnsServers -contains $o.daddr))
      $okApi = ($o.proto -eq 'tcp' -and ($o.dport -eq '443' -or $o.sport -eq '443') -and ($allowedIps -contains $o.saddr -or $allowedIps -contains $o.daddr))
      if (-not ($okDns -or $okApi)) {
        $verdict = 'FAIL'
        # NAME the peer. A TCP/80 contact to a certificate authority is the known
        # legitimate reason this can fail (AIA: Chromium fetches a missing
        # intermediate from the URL inside the server certificate, plus DNS for
        # that host - neither is a URLRequest, so no filter sees it). The answer
        # is to report the host so the consent copy can say a certificate may be
        # fetched, NOT to fold the host into this allowlist.
        $ptr = ''
        try { $ptr = (Resolve-DnsName -Name $peer -Type PTR -ErrorAction Stop | Select-Object -First 1).NameHost } catch { $ptr = '(no PTR)' }
        $null = $reasons.Add("endpoint outside the allowlist: $($o.proto) $($o.saddr):$($o.sport) -> $($o.daddr):$($o.dport) peer=$peer ptr=$ptr")
      }
    }
    if ($connects.Count -gt $budget) {
      $verdict = 'FAIL'
      $null = $reasons.Add("$($connects.Count) tcp connection attempts, budget $budget (MIN_GAP_MS $MIN_GAP_MINUTES min + one at startup)")
    }
    # A window with no request proves nothing about the request it exists to
    # measure: the provider switched off, a stale schedule, another instance
    # spending the shared slots. Say so rather than pass.
    if ($connects.Count -eq 0) {
      $verdict = 'FAIL'
      $null = $reasons.Add('no tcp connection attempt was observed, so the keyed request was never measured')
    }
    Say ("connection attempts: " + $connects.Count + " / budget " + $budget)
  }
  'C' {
    if (-not $removalAt) { $verdict = 'FAIL'; $null = $reasons.Add('the key was never removed during the window, so nothing was proven') }
    else {
      $after = @($offenders | Where-Object { [datetime]::Parse($_.at) -gt $removalAt })
      if ($after.Count -gt 0) { $verdict = 'FAIL'; $null = $reasons.Add("$($after.Count) non-loopback events after the key was removed") }
    }
  }
}

$summary = [pscustomobject]@{
  case = $Case; verdict = $verdict; reasons = @($reasons)
  minutes = $Minutes; exe = $exe; userDataDir = $userData; extraArgs = @($ExtraArgs)
  startedAt = $startedAt.ToString('o'); endedAt = $endedAt.ToString('o')
  keyRemovedAt = $(if ($removalAt) { $removalAt.ToString('o') } else { $null })
  adapterToggled = $(if ($ToggleAdapter) { $ToggleAdapter } else { $null })
  adapterDownAt = $(if ($toggleStartedAt) { $toggleStartedAt.ToString('o') } else { $null })
  adapterUpAt = $(if ($toggleEndedAt) { $toggleEndedAt.ToString('o') } else { $null })
  appSurvivedWindow = (-not $deadAt)
  appExitedAt = $(if ($deadAt) { $deadAt.ToString('o') } else { $null })
  livenessTicks = $aliveTicks
  etwBuffersWritten = $buffersWritten
  etwBuffersLost = $buffersLost
  # Proof that a zero above came from a working pipeline rather than a broken one.
  positiveControlPassed = (-not $SkipEtw)
  childRoles = @($childRoles | Sort-Object)
  # Top level only. Recursing pulls in every Chromium cache entry and buries the
  # one thing this is for: proof the app came up far enough to write its profile.
  userDataEntries = @(Get-ChildItem -LiteralPath $userData -ErrorAction SilentlyContinue |
    ForEach-Object { $_.Name + $(if ($_.PSIsContainer) { '\' } else { ' (' + $_.Length + ' B)' }) } | Sort-Object)
  pidsSeen = @($pidInfo.Keys | Sort-Object | ForEach-Object { $pidInfo[$_] })
  offenders = @($offenders)
  etwEvents = $events.Count; nonLoopbackEvents = $offenders.Count
  samplerRows = $samples.Count; samplerNonLoopbackTcp = $sampledRemote.Count
  etwUsed = (-not $SkipEtw); elevated = $isAdmin
  dnsServers = $dnsServers; allowedIps = $allowedIps
  outDir = $OutDir
}
$summary | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $OutDir 'summary.json')
$summary | Format-List | Out-String | Write-Host

if ($verdict -ne 'PASS') { Fail (($reasons) -join '; ') }
Say "PASS"
exit 0
