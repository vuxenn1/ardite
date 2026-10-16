# Ardite management script - the .bat files call this.
# Usage: ardite.ps1 <start|stop|restart|autostart-on|autostart-off|firewall|firewall-off|uninstall|status>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'stop', 'restart', 'autostart-on', 'autostart-off', 'firewall', 'firewall-off', 'uninstall', 'status')]
  [string]$Action
)

$Root = Split-Path -Parent $PSScriptRoot
$Vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$Lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Ardite.lnk'
$RuleName = 'Ardite (video downloader)'

$Port = 7878
$cfgFile = Join-Path $Root 'data\config.json'
if (Test-Path $cfgFile) {
  try {
    $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
    if ($cfg.port) { $Port = [int]$cfg.port }
  } catch { }
}

function Get-ArditePid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess }
  return $null
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-Ardite {
  if (Get-ArditePid) { Write-Host "  Ardite is already running: http://localhost:$Port"; return }
  Start-Process wscript.exe -ArgumentList "`"$Vbs`""
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    if (Get-ArditePid) { Write-Host "  Ardite started: http://localhost:$Port" -ForegroundColor Green; return }
  }
  Write-Host "  Ardite could not be started. See data\ardite.log for details." -ForegroundColor Red
}

function Stop-Ardite {
  $procId = Get-ArditePid
  if (-not $procId) { Write-Host '  Ardite is not running.'; return }
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  # also stop unfinished downloads
  Get-CimInstance Win32_Process -Filter "Name='yt-dlp.exe' OR Name='ffmpeg.exe'" |
    Where-Object { $_.ExecutablePath -like "$Root*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host '  Ardite stopped.'
}

function Enable-Autostart {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($Lnk)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $s.Arguments = "`"$Vbs`""
  $s.WorkingDirectory = $Root
  $s.Description = 'Ardite video downloader (background)'
  $s.Save()
  Write-Host '  Ardite will start automatically when you log in to Windows.' -ForegroundColor Green
}

function Disable-Autostart {
  if (Test-Path $Lnk) { Remove-Item $Lnk -Force }
  Write-Host '  Autostart disabled.'
}

function Invoke-Elevated([string]$action) {
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $action"
}

function Set-Firewall {
  if (-not (Test-Admin)) { Invoke-Elevated 'firewall'; return }

  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
  Write-Host "  Firewall: devices on your home network can reach port $Port." -ForegroundColor Green

  $waitForUser = $false

  # Clicking "Cancel" on an earlier Windows firewall prompt creates a block rule for node.exe that overrides the allow rule
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) {
    $blocks = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
      Where-Object { $_.Program -ieq $node } | Get-NetFirewallRule |
      Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }
    if ($blocks) {
      $waitForUser = $true
      Write-Host '  A firewall rule is BLOCKING incoming connections to Node.js; phones will not be able to connect.' -ForegroundColor Yellow
      $r = Read-Host '  Disable these block rules? (Y/N)'
      if ($r -match '^[yY]') { $blocks | Disable-NetFirewallRule; Write-Host '  Disabled.' -ForegroundColor Green }
    }
  }

  foreach ($n in (Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public')) {
    $waitForUser = $true
    Write-Host ''
    Write-Host "  The network '$($n.Name)' is marked as Public in Windows." -ForegroundColor Yellow
    Write-Host '  Your home network must be Private for phones to connect.'
    $r = Read-Host '  If this is your home network, make it Private? (Y/N)'
    if ($r -match '^[yY]') {
      Set-NetConnectionProfile -InterfaceIndex $n.InterfaceIndex -NetworkCategory Private
      Write-Host '  Network set to Private.' -ForegroundColor Green
    }
  }

  if ($waitForUser) { Read-Host '  Press Enter to close' | Out-Null } else { Start-Sleep -Seconds 2 }
}

function Remove-Firewall {
  if (-not (Test-Admin)) { Invoke-Elevated 'firewall-off'; return }
  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  Write-Host '  Firewall rule removed.'
  Start-Sleep -Seconds 1
}

function Show-Status {
  $procId = Get-ArditePid
  Write-Host ''
  if ($procId) { Write-Host '  Status    : RUNNING' -ForegroundColor Green } else { Write-Host '  Status    : stopped' -ForegroundColor Yellow }
  Write-Host ('  Autostart : ' + $(if (Test-Path $Lnk) { 'on' } else { 'off' }))
  $rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  Write-Host ('  Firewall  : ' + $(if ($rule) { 'allowed' } else { 'no rule' }))
  Write-Host "  This PC   : http://localhost:$Port"
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|WSL|Docker|Loopback|WARP|Cloudflare|Tailscale|ZeroTier|Hamachi|Bluetooth' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
    ForEach-Object { Write-Host "  Phone     : http://$($_.IPAddress):$Port" }
  Write-Host ''
}

switch ($Action) {
  'start' { Start-Ardite }
  'stop' { Stop-Ardite }
  'restart' { Stop-Ardite; Start-Sleep -Milliseconds 500; Start-Ardite }
  'autostart-on' { Enable-Autostart }
  'autostart-off' { Disable-Autostart }
  'firewall' { Set-Firewall }
  'firewall-off' { Remove-Firewall }
  'uninstall' { Stop-Ardite; Disable-Autostart; Remove-Firewall }
  'status' { Show-Status }
}
