# Installs an Ardite update that the server has downloaded and unpacked (see updater.js).
# Runs from a copy in data\update while the server has stopped: backs up the current files,
# copies the new ones over, starts Ardite and checks it answers with the new version.
# If it doesn't, the backup is put back and the old version is started again.
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$NewDir,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$OldVersion,
  [Parameter(Mandatory = $true)][int]$OldPid
)

$ErrorActionPreference = 'Stop'
$UpdateDir = Split-Path -Parent $PSCommandPath
$LogFile = Join-Path $UpdateDir 'update.log'
$Backup = Join-Path $UpdateDir 'backup'

function Write-Log([string]$Message) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Add-Content -Path $LogFile -Encoding UTF8
}

function Test-Running([string]$Expected) {
  # nothing listening yet: don't even ask (a refused request can take seconds in Windows PowerShell)
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return $false }
  try {
    $s = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 3 -UseBasicParsing
    return $s.name -eq 'Ardite' -and $s.version -eq $Expected
  } catch { return $false }
}

# Waits by the clock, not by attempts, so a slow check can't stretch the wait
function Wait-Running([string]$Expected, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Running $Expected) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Start-Ardite {
  Start-Process wscript.exe -ArgumentList "`"$(Join-Path $AppDir 'scripts\start-hidden.vbs')`"" -WorkingDirectory $AppDir
}

# Stops Ardite and its tools, but only programs that live in this Ardite folder
function Stop-Ardite {
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='yt-dlp.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Copies every file and folder from one place over another (folders are merged)
function Copy-Over([string]$From, [string]$To) {
  Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $To -Recurse -Force
  }
}

# Release packages list their files in files.txt ("public/app.js" etc.). data and bin are never in it.
function Read-FileList([string]$Dir) {
  $list = Join-Path $Dir 'files.txt'
  if (-not (Test-Path -LiteralPath $list)) { return $null }
  return @(Get-Content -LiteralPath $list | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and $_ -notmatch '(^|/)\.\.(/|$)' -and $_ -notmatch '^(data|bin)(/|$)' -and $_ -notmatch '^[/\\]|:' })
}

# Files the previous version shipped that the new one doesn't: left behind they could confuse
# the new version (e.g. an old script under a name that's free again)
function Get-StaleFiles {
  $old = Read-FileList $AppDir
  $new = Read-FileList $NewDir
  if ($null -eq $old -or $null -eq $new) { return @() }
  $keep = @{}
  foreach ($f in $new) { $keep[$f.ToLowerInvariant()] = $true }
  return @($old | Where-Object { -not $keep[$_.ToLowerInvariant()] })
}

function Remove-StaleFiles([string[]]$Stale) {
  foreach ($rel in $Stale) {
    $path = Join-Path $AppDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    Remove-Item -LiteralPath $path -Force
    Write-Log "removed $rel (not part of v$Version)"
    # and its folder, if that's now empty
    $dir = Split-Path -Parent $path
    if ($dir -ne $AppDir -and -not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
  }
}

function Restore-Backup {
  Write-Log 'putting the previous version back'
  Stop-Ardite
  Start-Sleep -Seconds 1
  Copy-Over $Backup $AppDir
  Start-Ardite
  if (Wait-Running $OldVersion 40) { Write-Log "rolled back to v$OldVersion" }
  else { Write-Log 'the previous version did not start either; run start.bat or install.bat' }
}

try {
  Write-Log "updating v$OldVersion -> v$Version in $AppDir"

  # 1. wait for the server to stop (it exits right after starting this script)
  try { Wait-Process -Id $OldPid -Timeout 30 -ErrorAction SilentlyContinue } catch { }
  Stop-Ardite
  Start-Sleep -Seconds 1

  # 2. back up exactly what is about to be replaced or removed; data and bin aren't in the package
  # and stay as they are
  $stale = Get-StaleFiles
  if (Test-Path $Backup) { Remove-Item $Backup -Recurse -Force }
  New-Item -ItemType Directory -Path $Backup | Out-Null
  $names = @(Get-ChildItem -LiteralPath $NewDir -Force | ForEach-Object { $_.Name })
  $names += @($stale | ForEach-Object { ($_ -split '/')[0] })
  foreach ($name in ($names | Sort-Object -Unique)) {
    $current = Join-Path $AppDir $name
    if (Test-Path -LiteralPath $current) { Copy-Item -LiteralPath $current -Destination $Backup -Recurse -Force }
  }
  Write-Log 'backup done'
} catch {
  Write-Log "could not prepare the update: $($_.Exception.Message)"
  Start-Ardite
  exit 1
}

try {
  # 3. new files in
  Copy-Over $NewDir $AppDir
  Write-Log 'new files copied'
  if ($stale.Count) { Remove-StaleFiles $stale }

  # 4. tools: downloads anything a new version needs and updates yt-dlp
  # (in Windows PowerShell, redirected error output of a program would otherwise stop this script)
  & {
    $ErrorActionPreference = 'Continue'
    & (Join-Path $AppDir 'runtime\node.exe') (Join-Path $AppDir 'setup.js') *> (Join-Path $UpdateDir 'setup.log')
    if ($LASTEXITCODE -ne 0) { Write-Log "setup exited with $LASTEXITCODE (see setup.log)" }
  }

  # 5. start and check
  Start-Ardite
  if (Wait-Running $Version 40) {
    Write-Log "updated to v$Version"
    Remove-Item (Split-Path -Parent $NewDir) -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
  }
  Write-Log "v$Version did not start"
  Restore-Backup
  exit 1
} catch {
  Write-Log "update failed: $($_.Exception.Message)"
  Restore-Backup
  exit 1
}
