<#
  backend/scripts/dc3/Send-NetworkInventory.ps1

  Runs on the domain controllers every 10 minutes (Task Scheduler, as
  SYSTEM) and sends inventory to the IT network page:
    POST https://app.petralu.net/api/network/ingest   (header X-Ingest-Token)

  -Parts picks what to send:
    dhcp    DHCP scopes, leases, reservations       (DC3 only -- DC2's scope
                                                      is an inactive standby copy)
    ad      Active Directory computers               (DC3)
    logons  last domain user per PC IP, from this DC's Kerberos TGT events
            (Security 4768) in the last 24 h          (every DC: each DC only
                                                      sees the logons it served)
  PETRA-DC3: -Parts dhcp,ad,logons     PETRA-DC2: -Parts logons
  PETRATH-DC01 (PetraTH.local, Thuhaiba, static IPs / no DHCP): -Parts ad,logons

  READ-ONLY on the DC: Get-DhcpServerv4*, Get-ADComputer, Get-WinEvent.
  Nothing on the DC or in AD is changed.

  Setup (once, elevated PowerShell on the DC):
    1. Copy this file to C:\Scripts\PetraNetwork\
    2. Put the token (same value as NETWORK_INGEST_TOKEN in the app's .env)
       in C:\Scripts\PetraNetwork\ingest-token.txt and lock it down:
         icacls C:\Scripts\PetraNetwork\ingest-token.txt /inheritance:r /grant:r "SYSTEM:R" "Administrators:R"
    3. Test once:  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Scripts\PetraNetwork\Send-NetworkInventory.ps1 -Parts dhcp,ad,logons
    4. Schedule (adjust -Parts per DC):
         $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\Scripts\PetraNetwork\Send-NetworkInventory.ps1 -Parts dhcp,ad,logons'
         $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)
         Register-ScheduledTask -TaskName 'Petra Network Inventory' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest
  Remove:  Unregister-ScheduledTask -TaskName 'Petra Network Inventory' -Confirm:$false
#>
param(
    [string[]]$Parts = @('dhcp', 'ad', 'logons'),
    [string]$ApiUrl = 'https://app.petralu.net/api/network/ingest',
    [string]$TokenFile = (Join-Path $PSScriptRoot 'ingest-token.txt'),
    [string]$LogFile = (Join-Path $PSScriptRoot 'last-run.log')
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# "-Parts dhcp,ad" from Task Scheduler arrives as one string.
$Parts = @($Parts | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })

function Iso($d) { if ($d) { ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }

try {
    $token = (Get-Content -Raw -Path $TokenFile).Trim()
    $body = [ordered]@{}
    $summary = @()

    # --- DHCP
    if ($Parts -contains 'dhcp') {
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
        $body.dhcp = [ordered]@{ server = $env:COMPUTERNAME; scopes = $scopes; leases = $leases; reservations = $reservations }
        $summary += "scopes=$($scopes.Count) leases=$($leases.Count) reservations=$($reservations.Count)"
    }

    # --- Active Directory computers
    if ($Parts -contains 'ad') {
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
        # NetBIOS domain name: the server keeps one AD list per domain
        # ('ad' = PETRALU, 'ad_PETRATH' from PETRATH-DC01).
        $body.ad = [ordered]@{ domain = (Get-ADDomain).NetBIOSName; computers = $computers }
        $summary += "computers=$($computers.Count)"
    }

    # --- last user per IP (Kerberos TGT requests = interactive/domain logons)
    if ($Parts -contains 'logons') {
        $latest = @{}
        $events = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4768; StartTime = (Get-Date).AddHours(-24) } -ErrorAction SilentlyContinue
        foreach ($e in $events) {
            $x = [xml]$e.ToXml()
            $d = @{}
            foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
            if ($d.Status -ne '0x0') { continue }                # failed requests
            $user = $d.TargetUserName
            if (-not $user -or $user.EndsWith('$')) { continue }  # computer accounts
            if ($user -match '^(krbtgt|HealthMailbox|SM_|\$)') { continue }
            $ip = $d.IpAddress -replace '^::ffff:', ''
            if ($ip -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $ip -eq '127.0.0.1') { continue }
            # Get-WinEvent returns newest first, so the first hit per IP wins.
            if (-not $latest.ContainsKey($ip)) {
                $latest[$ip] = [ordered]@{ ip = $ip; user = $user; domain = $d.TargetDomainName; time = Iso $e.TimeCreated }
            }
        }
        $body.logons = [ordered]@{ dc = $env:COMPUTERNAME; items = @($latest.Values) }
        $summary += "logons=$($latest.Count)"
    }

    $json = $body | ConvertTo-Json -Depth 6 -Compress
    $resp = Invoke-RestMethod -Method Post -Uri $ApiUrl -Headers @{ 'X-Ingest-Token' = $token } `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
    "$(Get-Date -Format s) OK $($summary -join ' ') saved=$($resp.saved -join ',')" | Set-Content -Path $LogFile
}
catch {
    "$(Get-Date -Format s) FAILED $($_.Exception.Message)" | Set-Content -Path $LogFile
    exit 1
}
