<#
  backend/scripts/veeam/Send-VeeamStatus.ps1

  Runs on the Veeam Backup & Replication server (Hyper-V host .93) every hour
  (Task Scheduler, as SYSTEM) and sends backup status to the IT Servers &
  Backups page:
    POST https://app.petralu.net/api/network/ingest   (header X-Ingest-Token, part "backup")

  Sends: every backup job (enabled, last 10 runs with start/end/result) and
  every repository (total/free space). The app works out late, failed and
  never-run jobs and low repository space, and sends phone alerts.

  READ-ONLY: Get-VBRJob, Get-VBRBackupSession, Get-VBRBackupRepository.
  It never starts, stops or changes a job, a backup file or a repository.

  Setup (once, elevated PowerShell on the Veeam server):
    1. Copy this file to C:\Scripts\PetraVeeam\
    2. Put the ingest token (same file as on DC3,
       C:\Scripts\PetraNetwork\ingest-token.txt) in
       C:\Scripts\PetraVeeam\ingest-token.txt and lock it down:
         icacls C:\Scripts\PetraVeeam\ingest-token.txt /inheritance:r /grant:r "SYSTEM:R" "Administrators:R"
    3. Test once:  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Scripts\PetraVeeam\Send-VeeamStatus.ps1 -DryRun
    4. Schedule:
         $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\Scripts\PetraVeeam\Send-VeeamStatus.ps1'
         $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
         Register-ScheduledTask -TaskName 'Petra Veeam Status' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest
  Remove:  Unregister-ScheduledTask -TaskName 'Petra Veeam Status' -Confirm:$false
#>
param(
    [string]$ApiUrl = 'https://app.petralu.net/api/network/ingest',
    [string]$TokenFile = (Join-Path $PSScriptRoot 'ingest-token.txt'),
    [string]$LogFile = (Join-Path $PSScriptRoot 'last-run.log'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Iso($d) { if ($d -and ([datetime]$d).Year -gt 2000) { ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }

try {
    Import-Module Veeam.Backup.PowerShell -WarningAction SilentlyContinue

    # Newest 10 runs per job, from one session query.
    $byJob = @{}
    Get-VBRBackupSession | Sort-Object CreationTime -Descending | ForEach-Object {
        if (-not $byJob.ContainsKey($_.JobName)) { $byJob[$_.JobName] = New-Object System.Collections.ArrayList }
        if ($byJob[$_.JobName].Count -lt 10) {
            [void]$byJob[$_.JobName].Add([ordered]@{
                start  = Iso $_.CreationTime
                end    = Iso $_.EndTime
                result = if ("$($_.State)" -eq 'Working') { 'Running' } else { "$($_.Result)" }
            })
        }
    }

    $jobs = @(Get-VBRJob -WarningAction SilentlyContinue | ForEach-Object {
        $runs = New-Object System.Collections.ArrayList
        if ($byJob.ContainsKey($_.Name)) { $runs = $byJob[$_.Name] }
        [ordered]@{
            name       = $_.Name
            type       = "$($_.JobType)"
            enabled    = [bool]$_.IsScheduleEnabled
            lastResult = "$($_.GetLastResult())"
            sessions   = $runs # an ArrayList stays a JSON array, even with 0 or 1 runs
        }
    })

    $repos = @(Get-VBRBackupRepository | ForEach-Object {
        $c = $_.GetContainer()
        [ordered]@{
            name    = $_.Name
            path    = "$($_.Path)"
            totalGb = [math]::Round($c.CachedTotalSpace.InGigabytes, 0)
            freeGb  = [math]::Round($c.CachedFreeSpace.InGigabytes, 0)
        }
    })

    $body = [ordered]@{
        backup = [ordered]@{
            server       = $env:COMPUTERNAME
            version      = "$((Get-Module Veeam.Backup.PowerShell).Version)"
            jobs         = $jobs
            repositories = $repos
        }
    }
    $json = $body | ConvertTo-Json -Depth 6 -Compress
    if ($DryRun) { $body | ConvertTo-Json -Depth 6; return }

    $token = (Get-Content -Raw -Path $TokenFile).Trim()
    $resp = Invoke-RestMethod -Method Post -Uri $ApiUrl -Headers @{ 'X-Ingest-Token' = $token } `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
    "$(Get-Date -Format s) OK jobs=$($jobs.Count) repos=$($repos.Count) saved=$($resp.saved -join ',')" | Set-Content -Path $LogFile
}
catch {
    "$(Get-Date -Format s) FAILED $($_.Exception.Message)" | Set-Content -Path $LogFile
    exit 1
}
