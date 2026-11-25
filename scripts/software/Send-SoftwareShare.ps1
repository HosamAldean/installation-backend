<#
  backend/scripts/software/Send-SoftwareShare.ps1

  Runs on PETRA-FILES every hour (Task Scheduler, as SYSTEM) and lists the
  installers in the IT software share for the Software Library page:
    POST https://app.petralu.net/api/network/ingest   (header X-Ingest-Token, part "softwareShare")

  Share: \\PETRA-FILES\Software$  =  F:\Software  (created 2026-11-25)
    NTFS: SYSTEM, Administrators, PETRALU\Domain Admins = Full;
          PETRALU\Domain Computers = Read (phase 2 installs run as SYSTEM).
    Normal users have no access, so nobody can swap an installer.

  Sends per installer (.msi .exe .msix .msixbundle .appx .msp .zip): UNC
  path, size, modified time, SHA-256, file/product version, product name,
  company. SHA-256 is cached in hash-cache.json and only recomputed when a
  file's size or modified time changes, so big installers are hashed once.

  READ-ONLY on the share: it reads files and their version info; it never
  changes, moves or runs an installer.

  Setup (once, elevated PowerShell on PETRA-FILES):
    1. Copy this file to C:\Scripts\PetraSoftware\
    2. Copy the ingest token (C:\Scripts\PetraNetwork\ingest-token.txt on
       DC3) to C:\Scripts\PetraSoftware\ingest-token.txt and lock it down:
         icacls C:\Scripts\PetraSoftware\ingest-token.txt /inheritance:r /grant:r "SYSTEM:R" "Administrators:R"
    3. Test:  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Scripts\PetraSoftware\Send-SoftwareShare.ps1 -DryRun
    4. Schedule:
         $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\Scripts\PetraSoftware\Send-SoftwareShare.ps1'
         $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
         Register-ScheduledTask -TaskName 'Petra Software Share' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest
  Remove:  Unregister-ScheduledTask -TaskName 'Petra Software Share' -Confirm:$false
#>
param(
    [string]$Root = 'F:\Software',
    [string]$UncRoot = '\\PETRA-FILES\Software$',
    [string]$ApiUrl = 'https://app.petralu.net/api/network/ingest',
    [string]$TokenFile = (Join-Path $PSScriptRoot 'ingest-token.txt'),
    [string]$CacheFile = (Join-Path $PSScriptRoot 'hash-cache.json'),
    [string]$LogFile = (Join-Path $PSScriptRoot 'last-run.log'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Iso($d) { if ($d) { ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }

# MSI ProductName/ProductVersion/Manufacturer, opened read-only (mode 0).
function MsiInfo($path) {
    $out = @{}
    try {
        $wi = New-Object -ComObject WindowsInstaller.Installer
        $db = $wi.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $wi, @($path, 0))
        foreach ($prop in 'ProductName', 'ProductVersion', 'Manufacturer') {
            $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT Value FROM Property WHERE Property='$prop'"))
            $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
            $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
            if ($rec) { $out[$prop] = $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, 1) }
            $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
        }
        [Runtime.InteropServices.Marshal]::ReleaseComObject($db) | Out-Null
    } catch { }
    return $out
}

try {
    $cache = @{}
    if (Test-Path $CacheFile) {
        try { (Get-Content -Raw $CacheFile | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cache[$_.Name] = $_.Value } } catch { }
    }
    $newCache = @{}
    $files = @()
    $exts = '.msi', '.exe', '.msix', '.msixbundle', '.appx', '.msp', '.zip'
    foreach ($f in Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $exts -contains $_.Extension.ToLower() } | Select-Object -First 2000) {
        $rel = $f.FullName.Substring($Root.Length).TrimStart('\')
        $stamp = "$($f.Length)|$($f.LastWriteTimeUtc.Ticks)"
        $c = $cache[$rel]
        $hash = if ($c -and $c.stamp -eq $stamp) { $c.sha256 } else { (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower() }
        $newCache[$rel] = @{ stamp = $stamp; sha256 = $hash }

        $product = $null; $version = $null; $company = $null
        if ($f.Extension -ieq '.msi') {
            $m = MsiInfo $f.FullName
            $product = $m.ProductName; $version = $m.ProductVersion; $company = $m.Manufacturer
        } elseif ($f.Extension -ieq '.exe') {
            $vi = $f.VersionInfo
            $product = $vi.ProductName; $version = if ($vi.ProductVersion) { $vi.ProductVersion.Trim() } else { $vi.FileVersion }; $company = $vi.CompanyName
        }
        $files += [ordered]@{
            path     = Join-Path $UncRoot $rel
            name     = $f.Name
            folder   = Split-Path $rel -Parent
            sizeMb   = [math]::Round($f.Length / 1MB, 1)
            modified = Iso $f.LastWriteTimeUtc
            sha256   = $hash
            version  = $version
            product  = $product
            company  = $company
        }
    }
    $newCache | ConvertTo-Json -Depth 3 | Set-Content -Path $CacheFile -Encoding UTF8

    $body = [ordered]@{ softwareShare = [ordered]@{ server = $env:COMPUTERNAME; root = $UncRoot; files = @($files) } }
    $json = $body | ConvertTo-Json -Depth 5 -Compress
    if ($DryRun) { $body | ConvertTo-Json -Depth 5; return }

    $token = (Get-Content -Raw -Path $TokenFile).Trim()
    $resp = Invoke-RestMethod -Method Post -Uri $ApiUrl -Headers @{ 'X-Ingest-Token' = $token } `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
    "$(Get-Date -Format s) OK files=$($files.Count) saved=$($resp.saved -join ',')" | Set-Content -Path $LogFile
}
catch {
    "$(Get-Date -Format s) FAILED $($_.Exception.Message)" | Set-Content -Path $LogFile
    exit 1
}
