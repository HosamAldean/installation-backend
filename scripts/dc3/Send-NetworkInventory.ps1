<#
  backend/scripts/dc3/Send-NetworkInventory.ps1

  Runs on PETRA-DC3 every 10 minutes (Task Scheduler, as SYSTEM) and sends
  the DHCP + Active Directory inventory to the IT network page:
    POST https://app.petralu.net/api/network/ingest   (header X-Ingest-Token)

  READ-ONLY on the DC: it only calls Get-DhcpServerv4* and Get-ADComputer.
  Nothing on the DC or in AD is changed.

  Setup (once, elevated PowerShell on DC3):
    1. Copy this file to C:\Scripts\PetraNetwork\
    2. Put the token (same value as NETWORK_INGEST_TOKEN in the app's .env)
       in C:\Scripts\PetraNetwork\ingest-token.txt and lock it down:
         icacls C:\Scripts\PetraNetwork\ingest-token.txt /inheritance:r /grant:r "SYSTEM:R" "Administrators:R"
    3. Test once:  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Scripts\PetraNetwork\Send-NetworkInventory.ps1
    4. Schedule:
         $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\Scripts\PetraNetwork\Send-NetworkInventory.ps1'
         $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)
         Register-ScheduledTask -TaskName 'Petra Network Inventory' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest
  Remove:  Unregister-ScheduledTask -TaskName 'Petra Network Inventory' -Confirm:$false
#>
param(
    [string]$ApiUrl = 'https://app.petralu.net/api/network/ingest',
    [string]$TokenFile = (Join-Path $PSScriptRoot 'ingest-token.txt'),
    [string]$LogFile = (Join-Path $PSScriptRoot 'last-run.log')
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Iso($d) { if ($d) { ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }

try {
    $token = (Get-Content -Raw -Path $TokenFile).Trim()

    # --- DHCP
    $scopes = @()
    $leases = @()
    $reservations = @()
    foreach ($scope in Get-DhcpServerv4Scope) {
        $stats = Get-DhcpServerv4ScopeStatistics -ScopeId $scope.ScopeId
        $scopes += [ordered]@{
            scopeId      = "$($scope.ScopeId)"
            name         = $scope.Name
            startRange   = "$($scope.StartRange)"
            endRange     = "$($scope.EndRange)"
            state        = "$($scope.State)"
            inUse        = [int]$stats.InUse
            free         = [int]$stats.Free
            percentInUse = [double]$stats.PercentageInUse
        }
        foreach ($l in Get-DhcpServerv4Lease -ScopeId $scope.ScopeId) {
            $leases += [ordered]@{
                ip           = "$($l.IPAddress)"
                mac          = $l.ClientId
                hostName     = $l.HostName
                addressState = "$($l.AddressState)"
                leaseExpiry  = Iso $l.LeaseExpiryTime
                scopeId      = "$($scope.ScopeId)"
            }
        }
        foreach ($r in Get-DhcpServerv4Reservation -ScopeId $scope.ScopeId) {
            $reservations += [ordered]@{
                ip          = "$($r.IPAddress)"
                mac         = $r.ClientId
                name        = $r.Name
                description = $r.Description
                scopeId     = "$($scope.ScopeId)"
            }
        }
    }

    # --- Active Directory computers
    Import-Module ActiveDirectory
    $computers = @()
    $props = 'OperatingSystem', 'OperatingSystemVersion', 'LastLogonTimestamp', 'Description', 'IPv4Address', 'DNSHostName', 'Enabled', 'DistinguishedName'
    foreach ($c in Get-ADComputer -Filter * -Properties $props) {
        $ou = ($c.DistinguishedName -split ',', 2)[1]
        $computers += [ordered]@{
            name        = $c.Name
            dnsHostName = $c.DNSHostName
            os          = $c.OperatingSystem
            osVersion   = $c.OperatingSystemVersion
            enabled     = [bool]$c.Enabled
            lastLogon   = if ($c.LastLogonTimestamp) { Iso ([datetime]::FromFileTime($c.LastLogonTimestamp)) } else { $null }
            description = $c.Description
            ou          = $ou
            ipv4        = $c.IPv4Address
        }
    }

    $body = [ordered]@{
        dhcp = [ordered]@{ server = $env:COMPUTERNAME; scopes = $scopes; leases = $leases; reservations = $reservations }
        ad   = [ordered]@{ computers = $computers }
    } | ConvertTo-Json -Depth 6 -Compress

    $resp = Invoke-RestMethod -Method Post -Uri $ApiUrl -Headers @{ 'X-Ingest-Token' = $token } `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
    "$(Get-Date -Format s) OK scopes=$($scopes.Count) leases=$($leases.Count) reservations=$($reservations.Count) computers=$($computers.Count) saved=$($resp.saved -join ',')" |
        Set-Content -Path $LogFile
}
catch {
    "$(Get-Date -Format s) FAILED $($_.Exception.Message)" | Set-Content -Path $LogFile
    exit 1
}
