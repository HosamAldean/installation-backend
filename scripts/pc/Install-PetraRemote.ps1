<#
  backend/scripts/pc/Install-PetraRemote.ps1

  Deployed by GPO "Petra Remote Agent" (as SYSTEM, at startup + every 4 hours)
  to every domain workstation. Installs the MeshCentral agent for the IT
  remote-control server (https://app.petralu.net:4430, group "Petra PCs")
  when it is not installed yet. If it is installed, it only makes sure the
  "Mesh Agent" service is running. Never uninstalls anything.

  The agent installer (PetraRemoteAgent64.exe, downloaded from the Mesh
  server for the "Petra PCs" group) sits next to this script in
  \\petralu.local\NETLOGON\PetraRemote\.

  Log: C:\ProgramData\PetraRemote\last-run.log
#>
param(
    [string]$Source = '\\petralu.local\NETLOGON\PetraRemote\PetraRemoteAgent64.exe'
)

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'PetraRemote'

function Write-RunLog($text) {
    try {
        New-Item -ItemType Directory -Force $dir | Out-Null
        "$(Get-Date -Format s) $text" | Set-Content -Path (Join-Path $dir 'last-run.log') -Encoding UTF8
    } catch { }
}

try {
    $svc = Get-Service -Name 'Mesh Agent' -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -ne 'Running') {
            Start-Service -Name 'Mesh Agent'
            Write-RunLog 'OK already installed; service started'
        } else {
            Write-RunLog 'OK already installed and running'
        }
        return
    }

    if (-not [Environment]::Is64BitOperatingSystem) {
        Write-RunLog 'SKIPPED 32-bit Windows (only the x64 agent is deployed)'
        return
    }

    New-Item -ItemType Directory -Force $dir | Out-Null
    $local = Join-Path $dir 'PetraRemoteAgent64.exe'
    Copy-Item -Path $Source -Destination $local -Force

    $p = Start-Process -FilePath $local -ArgumentList '-fullinstall' -WindowStyle Hidden -PassThru
    if (-not $p.WaitForExit(180000)) { try { $p.Kill() } catch { } ; throw 'installer timed out after 3 minutes' }
    Start-Sleep -Seconds 5

    $svc = Get-Service -Name 'Mesh Agent' -ErrorAction SilentlyContinue
    if ($svc) {
        Write-RunLog "OK installed (exit $($p.ExitCode)); service $($svc.Status)"
    } else {
        Write-RunLog "FAILED installer exit $($p.ExitCode); service not found"
        exit 1
    }
    Remove-Item $local -Force -ErrorAction SilentlyContinue
}
catch {
    Write-RunLog "FAILED at line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"
    exit 1
}
