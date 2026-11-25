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
    hygiene AD + DNS hygiene for the IT Servers & Backups page, sent once an
            hour (first run after :00; -HygieneNow sends it straight away):
            stale accounts, pre-2012 passwords, admin groups, A records on
            the domain name, zone update/aging settings
                                                     (DC3 + PETRATH-DC01)
  Since 2026-11-25: PETRA-DC3 -Parts dhcp,ad,logons,hygiene;
  PETRATH-DC01 -Parts ad,logons,hygiene

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
    [string]$LogFile = (Join-Path $PSScriptRoot 'last-run.log'),
    [switch]$HygieneNow
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

    # --- AD + DNS hygiene, once an hour (the task runs every 10 min):
    # stale enabled accounts, passwords older than 2012 (RC4-only keys),
    # admin group members, junk A records on the domain name itself, zone
    # update/aging settings. Read-only, like the rest of this script.
    if ($Parts -contains 'hygiene' -and ($HygieneNow -or (Get-Date).Minute -lt 10)) {
        Import-Module ActiveDirectory
        Import-Module DnsServer
        $dom = Get-ADDomain
        $cut = (Get-Date).AddDays(-90)
        $oldPw = [datetime]'2012-01-01'
        function LastLogon($o) { if ($o.LastLogonTimestamp) { [datetime]::FromFileTime($o.LastLogonTimestamp) } else { $null } }
        function Person($o) {
            [ordered]@{
                name       = $o.SamAccountName -replace '\$$', ''
                display    = $o.DisplayName
                os         = $o.OperatingSystem
                lastLogon  = Iso (LastLogon $o)
                pwdLastSet = if ($o.pwdLastSet -gt 0) { Iso ([datetime]::FromFileTime($o.pwdLastSet)) } else { $null }
                created    = Iso $o.whenCreated
            }
        }
        $isStale = { $_.whenCreated -lt $cut -and (-not (LastLogon $_) -or (LastLogon $_) -lt $cut) }

        # Every real IPv4 of each DC (not just the one AD picks -- that can be
        # a 169.254 address from an unconfigured second port).
        $dcs = @(Get-ADDomainController -Filter * | ForEach-Object {
            $ips = @([System.Net.Dns]::GetHostAddresses($_.HostName) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
                ForEach-Object { $_.IPAddressToString }) + @($_.IPv4Address) | Where-Object { $_ -and $_ -notlike '169.254.*' } | Select-Object -Unique
            [ordered]@{ name = $_.Name; ip = $_.IPv4Address; ips = @($ips) }
        })
        $comps = @(Get-ADComputer -Filter 'Enabled -eq $true' -Properties LastLogonTimestamp, OperatingSystem, whenCreated, pwdLastSet)
        $users = @(Get-ADUser -Filter 'Enabled -eq $true' -Properties LastLogonTimestamp, pwdLastSet, PasswordNeverExpires, whenCreated, DisplayName |
            Where-Object { $_.SamAccountName -notmatch '^(krbtgt|HealthMailbox|SM_|\$)' })
        $staleComps = @($comps | Where-Object $isStale)
        $staleUsers = @($users | Where-Object $isStale)
        $oldPwUsers = @($users | Where-Object { $_.pwdLastSet -gt 0 -and [datetime]::FromFileTime($_.pwdLastSet) -lt $oldPw })

        $admins = @()
        foreach ($g in 'Domain Admins', 'Enterprise Admins', 'Schema Admins', 'Administrators') {
            try {
                $m = @(Get-ADGroupMember -Identity $g -Recursive | Where-Object { $_.objectClass -eq 'user' } | ForEach-Object { $_.SamAccountName })
                $admins += [ordered]@{ group = $g; members = $m }
            } catch { } # Enterprise/Schema Admins only exist in the forest root
        }

        $zone = $dom.DNSRoot
        $apex = @(Get-DnsServerResourceRecord -ZoneName $zone -Name '@' -RRType A | ForEach-Object {
            [ordered]@{ ip = $_.RecordData.IPv4Address.IPAddressToString; static = -not $_.Timestamp; stamp = Iso $_.Timestamp }
        })

        $body.hygiene = [ordered]@{
            domain    = $dom.NetBIOSName
            dc        = $env:COMPUTERNAME
            dcs       = $dcs
            computers = [ordered]@{
                enabled      = $comps.Count
                staleCount   = $staleComps.Count
                staleEnabled = @($staleComps | Sort-Object LastLogonTimestamp | Select-Object -First 300 | ForEach-Object { Person $_ })
            }
            users     = [ordered]@{
                enabled         = $users.Count
                pwdNeverExpires = @($users | Where-Object { $_.PasswordNeverExpires }).Count
                neverLoggedOn   = @($users | Where-Object { -not $_.LastLogonTimestamp -and $_.whenCreated -lt (Get-Date).AddDays(-30) }).Count
                staleCount      = $staleUsers.Count
                oldPwCount      = $oldPwUsers.Count
                staleEnabled    = @($staleUsers | Sort-Object LastLogonTimestamp | Select-Object -First 300 | ForEach-Object { Person $_ })
                oldPasswords    = @($oldPwUsers | Sort-Object pwdLastSet | Select-Object -First 300 | ForEach-Object { Person $_ })
            }
            admins    = $admins
            dns       = [ordered]@{
                zone          = $zone
                dynamicUpdate = "$((Get-DnsServerZone -Name $zone).DynamicUpdate)"
                aging         = [bool](Get-DnsServerZoneAging -Name $zone).AgingEnabled
                scavenging    = [bool](Get-DnsServerScavenging).ScavengingState
                apex          = $apex
            }
        }
        $summary += "hygiene=$($dom.NetBIOSName) apex=$($apex.Count)"
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
