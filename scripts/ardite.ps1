# Ardite yönetim scripti — .bat dosyaları bunu çağırır.
# Kullanım: ardite.ps1 <baslat|durdur|yeniden|otomatik-ac|otomatik-kapat|guvenlik-duvari|kaldir|durum>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('baslat', 'durdur', 'yeniden', 'otomatik-ac', 'otomatik-kapat', 'guvenlik-duvari', 'kaldir', 'durum')]
  [string]$Islem
)

$Root = Split-Path -Parent $PSScriptRoot
$Vbs = Join-Path $PSScriptRoot 'gizli-baslat.vbs'
$Lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Ardite.lnk'
$RuleName = 'Ardite (video indirici)'

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
  if (Get-ArditePid) { Write-Host "  Ardite zaten çalışıyor → http://localhost:$Port"; return }
  Start-Process wscript.exe -ArgumentList "`"$Vbs`""
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    if (Get-ArditePid) { Write-Host "  Ardite başladı → http://localhost:$Port" -ForegroundColor Green; return }
  }
  Write-Host "  Ardite başlatılamadı. Ayrıntı için data\ardite.log dosyasına bak." -ForegroundColor Red
}

function Stop-Ardite {
  $procId = Get-ArditePid
  if (-not $procId) { Write-Host '  Ardite zaten çalışmıyor.'; return }
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  # yarım kalan indirmeleri de kapat
  Get-CimInstance Win32_Process -Filter "Name='yt-dlp.exe' OR Name='ffmpeg.exe'" |
    Where-Object { $_.ExecutablePath -like "$Root*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host '  Ardite durduruldu.'
}

function Enable-Autostart {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($Lnk)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $s.Arguments = "`"$Vbs`""
  $s.WorkingDirectory = $Root
  $s.Description = 'Ardite video indirici (arka planda)'
  $s.Save()
  Write-Host '  Windows açılınca Ardite otomatik başlayacak.' -ForegroundColor Green
}

function Disable-Autostart {
  if (Test-Path $Lnk) { Remove-Item $Lnk -Force }
  Write-Host '  Otomatik başlatma kapatıldı.'
}

function Invoke-Elevated([string]$action) {
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $action"
}

function Set-Firewall {
  if (-not (Test-Admin)) { Invoke-Elevated 'guvenlik-duvari'; return }

  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
  Write-Host "  Güvenlik duvarı: ev ağındaki cihazlar $Port portuna erişebilir." -ForegroundColor Green

  $waitForUser = $false

  # Daha önce Windows'un sorduğu pencerede "İptal" denmişse node.exe için engelleme kuralı oluşur ve izni ezer
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) {
    $blocks = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
      Where-Object { $_.Program -ieq $node } | Get-NetFirewallRule |
      Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }
    if ($blocks) {
      $waitForUser = $true
      Write-Host "  Node.js için gelen bağlantıları ENGELLEYEN kural var; telefondan erişimi bozar." -ForegroundColor Yellow
      $r = Read-Host '  Bu engelleme kurallarını kapatayım mı? (E/H)'
      if ($r -match '^[eEyY]') { $blocks | Disable-NetFirewallRule; Write-Host '  Kapatıldı.' -ForegroundColor Green }
    }
  }

  foreach ($n in (Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public')) {
    $waitForUser = $true
    Write-Host ''
    Write-Host "  '$($n.Name)' ağı Windows'ta 'Genel' olarak işaretli." -ForegroundColor Yellow
    Write-Host '  Telefondan erişebilmek için evinin ağı "Özel" olmalı (yazıcı paylaşımı vb. için de gerekir).'
    $r = Read-Host '  Bu ağ evinin ağıysa "Özel" yapayım mı? (E/H)'
    if ($r -match '^[eEyY]') {
      Set-NetConnectionProfile -InterfaceIndex $n.InterfaceIndex -NetworkCategory Private
      Write-Host '  Ağ "Özel" yapıldı.' -ForegroundColor Green
    }
  }

  if ($waitForUser) { Read-Host '  Kapatmak için Enter' | Out-Null } else { Start-Sleep -Seconds 2 }
}

function Remove-Firewall {
  if (-not (Test-Admin)) { Invoke-Elevated 'kaldir'; return }
  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  Write-Host '  Güvenlik duvarı kuralı silindi.'
  Start-Sleep -Seconds 1
}

function Show-Status {
  $procId = Get-ArditePid
  Write-Host ''
  if ($procId) { Write-Host "  Durum           : ÇALIŞIYOR" -ForegroundColor Green } else { Write-Host '  Durum           : kapalı' -ForegroundColor Yellow }
  Write-Host ("  Otomatik başlat : " + $(if (Test-Path $Lnk) { 'açık' } else { 'kapalı' }))
  $rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  Write-Host ("  Güvenlik duvarı : " + $(if ($rule) { 'izin var' } else { 'kural yok' }))
  Write-Host "  Bu bilgisayarda : http://localhost:$Port"
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WARP|Bluetooth|VirtualBox|VMware' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
    ForEach-Object { Write-Host "  Telefondan      : http://$($_.IPAddress):$Port" }
  Write-Host ''
}

switch ($Islem) {
  'baslat' { Start-Ardite }
  'durdur' { Stop-Ardite }
  'yeniden' { Stop-Ardite; Start-Sleep -Milliseconds 500; Start-Ardite }
  'otomatik-ac' { Enable-Autostart }
  'otomatik-kapat' { Disable-Autostart }
  'guvenlik-duvari' { Set-Firewall }
  'kaldir' {
    if (Test-Admin) { Remove-Firewall; return }
    Stop-Ardite; Disable-Autostart; Remove-Firewall
  }
  'durum' { Show-Status }
}
