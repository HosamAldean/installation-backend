<#
  backend/scripts/pc/Send-PcReport.ps1

  Runs on every domain PC (deployed by GPO, as SYSTEM, at startup and every
  4 hours) and reports the PC to the IT network page:
    POST https://app.petralu.net/api/network/report   (header X-Report-Token)

  Sends: computer name, logged-on user, Windows edition/build, Windows and
  Office license/activation status (SoftwareLicensingProduct), installed
  Office products (Uninstall registry + Click-to-Run config), NICs (MAC/IP),
  make/model/serial, CPU (model/cores/load), RAM (total/free), drives
  (size/free) and physical disks (SSD/HDD, health).
  Since 2026-11-25 also: antivirus (Security Center, Defender, Trend Micro
  agent services + update status) and health (real running time with Fast
  Startup, kernel memory pool, commit, top processes, pending restart,
  Windows Update history).

  READ-ONLY on the PC: CIM queries and registry reads. It changes nothing --
  it does not activate, install or remove anything.

  The token below is the LOW-privilege report token (NETWORK_REPORT_TOKEN),
  readable by any domain user in SYSVOL by design: all it allows is
  overwriting one PC's report on the page.

  Test by hand (elevated):  powershell -NoProfile -ExecutionPolicy Bypass -File Send-PcReport.ps1 -DryRun
#>
param(
    [string]$ApiUrl = 'https://app.petralu.net/api/network/report',
    [string]$Token = '__REPORT_TOKEN__',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Iso($d) { if ($d) { ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }

# One-line result for troubleshooting: C:\ProgramData\PetraPcReport\last-run.log
# (ProgramData is readable by every local user; no secrets are written).
function Write-RunLog($text) {
    try {
        $dir = Join-Path $env:ProgramData 'PetraPcReport'
        New-Item -ItemType Directory -Force $dir | Out-Null
        "$(Get-Date -Format s) [$([Security.Principal.WindowsIdentity]::GetCurrent().Name)] $text" |
            Set-Content -Path (Join-Path $dir 'last-run.log') -Encoding UTF8
    } catch { }
}

$WindowsAppId = '55c92734-d682-4d71-983e-d6ec3f16059f'
$OfficeAppId = '0ff1ce15-a989-479d-af46-f275c6370663'

function LicenseRows($items) {
    @($items | ForEach-Object {
        [ordered]@{
            name          = $_.Name
            description   = $_.Description
            status        = [int]$_.LicenseStatus
            partialKey    = $_.PartialProductKey
            kmsHost       = $_.KeyManagementServiceMachine
            kmsDiscovered = $_.DiscoveredKeyManagementServiceMachineName
            graceMinutes  = [int]$_.GracePeriodRemaining
        }
    })
}

try {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $bios = Get-CimInstance Win32_BIOS
    $cv = try { Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop } catch { $null }

    # Licenses with a key installed (filtering on PartialProductKey keeps the
    # query fast). Office 2010 licenses live in OfficeSoftwareProtectionProduct.
    $lic = @(Get-CimInstance SoftwareLicensingProduct -Filter 'PartialProductKey IS NOT NULL')
    $winLic = LicenseRows ($lic | Where-Object { $_.ApplicationID -eq $WindowsAppId })
    $offLic = @(LicenseRows ($lic | Where-Object { $_.ApplicationID -eq $OfficeAppId }))
    try {
        $offLic += LicenseRows (Get-CimInstance OfficeSoftwareProtectionProduct -Filter 'PartialProductKey IS NOT NULL' -ErrorAction Stop)
    } catch { }

    # Installed Office (MSI + Click-to-Run entries), without updates,
    # language packs, proofing tools and helper components.
    # Read each uninstall key on its own: one malformed value (e.g. a DWORD
    # with the wrong size) makes Get-ItemProperty throw "Specified cast is not
    # valid" as a terminating error, which used to abort the whole report.
    $roots = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
             'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    $entries = foreach ($root in $roots) {
        foreach ($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
            try { Get-ItemProperty $key.PSPath -ErrorAction Stop } catch { }
        }
    }
    $office = @($entries |
        Where-Object {
            $_.DisplayName -match '^(Microsoft (Office|365|Visio|Project|Word|Excel|Outlook|PowerPoint|Access|Publisher)\b)' -and
            $_.DisplayName -notmatch '(Update|Language|Proof|MUI|Shared|Click-to-Run|Extensibility|Licensing|Localization|Interop|Primary Interop|Runtime|Tools|Add-in|Components|Viewer|Validation|Web Components|Get Started|Live Meeting|Visual Studio)' -and
            -not $_.SystemComponent -and -not $_.ParentKeyName
        } |
        Sort-Object DisplayName -Unique |
        ForEach-Object {
            [ordered]@{
                name    = $_.DisplayName
                version = $_.DisplayVersion
                source  = if ($_.PSChildName -match '^O365|ProPlus|Retail|Volume' -or $_.UninstallString -match 'OfficeClickToRun') { 'c2r' } else { 'msi' }
            }
        })

    $c2r = $null
    $cfg = try { Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction Stop } catch { $null }
    if ($cfg) {
        $c2r = [ordered]@{
            productIds = $cfg.ProductReleaseIds
            version    = $cfg.VersionToReport
            platform   = $cfg.Platform
            channel    = if ($cfg.UpdateChannel) { $cfg.UpdateChannel } else { $cfg.CDNBaseUrl }
        }
    }

    # CPU / RAM / disks (read-only CIM queries)
    $cpus = @(Get-CimInstance Win32_Processor)
    $cpu = [ordered]@{
        name    = (($cpus | Select-Object -First 1).Name -replace '\s+', ' ').Trim()
        sockets = $cpus.Count
        cores   = [int](($cpus | Measure-Object NumberOfCores -Sum).Sum)
        threads = [int](($cpus | Measure-Object NumberOfLogicalProcessors -Sum).Sum)
        loadPct = [int](($cpus | Measure-Object LoadPercentage -Average).Average)
    }
    $volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' |
        ForEach-Object {
            [ordered]@{
                drive  = $_.DeviceID
                label  = $_.VolumeName
                fs     = $_.FileSystem
                sizeGb = [math]::Round($_.Size / 1GB, 1)
                freeGb = [math]::Round($_.FreeSpace / 1GB, 1)
            }
        })
    $physical = @()
    try {
        $physical = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
            [ordered]@{
                model     = ($_.FriendlyName -replace '\s+', ' ').Trim()
                mediaType = "$($_.MediaType)"
                busType   = "$($_.BusType)"
                sizeGb    = [math]::Round($_.Size / 1GB, 0)
                health    = "$($_.HealthStatus)"
            }
        })
    } catch { }

    $nics = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = TRUE' |
        Where-Object { $_.MACAddress } |
        ForEach-Object {
            [ordered]@{
                mac = $_.MACAddress
                ip  = @($_.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0]
            }
        })

    # --- Antivirus (read-only). Security Center lists what Windows thinks
    # protects the PC (workstations only -- Windows Server has no
    # SecurityCenter2). productState: bits 12-15 = 1 on, bits 4-7 = 0 up to date.
    $avProducts = @()
    try {
        $avProducts = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop |
            ForEach-Object {
                $st = [int]$_.productState
                [ordered]@{
                    name     = $_.displayName
                    state    = $st
                    enabled  = ((($st -shr 12) -band 0xF) -eq 1)
                    upToDate = ((($st -shr 4) -band 0xF) -eq 0)
                }
            })
    } catch { }

    # Defender: throws when its service is stopped (Trend installed) -- fine.
    $defender = $null
    try {
        $mp = Get-MpComputerStatus -ErrorAction Stop
        $defender = [ordered]@{
            mode             = "$($mp.AMRunningMode)"
            serviceEnabled   = [bool]$mp.AMServiceEnabled
            antivirusEnabled = [bool]$mp.AntivirusEnabled
            realTime         = [bool]$mp.RealTimeProtectionEnabled
            signatureUpdated = Iso $mp.AntivirusSignatureLastUpdated
            quickScan        = Iso $mp.QuickScanEndTime
        }
    } catch { }

    # Trend Micro Worry-Free / Apex One agent: services + its own registry
    # status. Values are read one by one (see the uninstall-key note above).
    function FromUnix($v) {
        if ($v -and [double]$v -gt 0) { (Get-Date '1970-01-01T00:00:00Z').ToUniversalTime().AddSeconds([double]$v).ToString('o') } else { $null }
    }
    function ParseLocal($v, $formats) {
        if (-not $v) { return $null }
        foreach ($f in $formats) {
            try { return Iso ([datetime]::ParseExact("$v", $f, [Globalization.CultureInfo]::InvariantCulture)) } catch { }
        }
        return $null
    }
    $trend = $null
    $trendSvc = @(Get-CimInstance Win32_Service -Filter "Name='ntrtscan' OR Name='tmlisten' OR Name='TMBMServer' OR Name='TmCCSF' OR Name='PccNTUpd' OR Name='TmPfw'" |
        ForEach-Object { [ordered]@{ name = $_.Name; state = "$($_.State)"; startMode = "$($_.StartMode)" } })
    $tk = $null
    foreach ($p in 'HKLM:\SOFTWARE\WOW6432Node\TrendMicro\PC-cillinNTCorp\CurrentVersion\Misc.',
                   'HKLM:\SOFTWARE\TrendMicro\PC-cillinNTCorp\CurrentVersion\Misc.') {
        if (-not $tk) { $tk = try { Get-Item -LiteralPath $p -ErrorAction Stop } catch { $null } }
    }
    if ($tk -or $trendSvc.Count) {
        $tv = { param($n) try { $tk.GetValue($n) } catch { $null } }
        $trend = [ordered]@{
            product           = if ($tk) { & $tv 'ProductName' } else { $null }
            version           = if ($tk) { "$(& $tv 'TmListen_Ver')" } else { $null }
            lastUpdate        = if ($tk) { FromUnix (& $tv 'LastUpdateTime') } else { $null }
            patternTooOld     = if ($tk) { [int](& $tv 'PatternTooOld') -eq 1 } else { $null }
            lastScheduledScan = if ($tk) { ParseLocal (& $tv 'VirusScheduleScanDateTime') @('yyyy/MM/dd HH:mm:ss') } else { $null }
            lastInfection     = if ($tk) { ParseLocal (& $tv 'LastInfectedSpywareDateTime') @('M/d/yyyy H:mm:ss', 'yyyy/MM/dd HH:mm:ss') } else { $null }
            services          = @($trendSvc)
        }
    }

    # --- Windows 11 readiness (read-only): TPM, firmware, Secure Boot, CPU.
    # The verdict (CPU generation etc.) is worked out on the server.
    $tpm = $null
    try {
        $t = Get-CimInstance -Namespace root/cimv2/Security/MicrosoftTpm -ClassName Win32_Tpm -ErrorAction Stop | Select-Object -First 1
        if ($t) {
            $tpm = [ordered]@{
                specVersion = $t.SpecVersion            # "2.0, 0, 1.38" or "1.2, 2, 3"
                enabled     = [bool]$t.IsEnabled_InitialValue
                activated   = [bool]$t.IsActivated_InitialValue
            }
        }
    } catch { }
    $secureBoot = $null
    try { $secureBoot = [bool](Confirm-SecureBootUEFI -ErrorAction Stop) } catch {
        try { $secureBoot = [int](Get-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -ErrorAction Stop).GetValue('UEFISecureBootEnabled') -eq 1 } catch { }
    }
    $cpu0 = $cpus | Select-Object -First 1
    $win11 = [ordered]@{
        firmware   = $env:firmware_type                 # UEFI / Legacy
        secureBoot = $secureBoot
        tpmPresent = [bool]$tpm
        tpm        = $tpm
        arch       = $os.OSArchitecture
        cpuMaker   = $cpu0.Manufacturer
        cpuCaption = $cpu0.Caption                      # Intel64 Family 6 Model 158 ...
    }

    # --- PC health (read-only)
    # Fast Startup keeps LastBootUpTime from the last full boot, so the real
    # "running since" is the newest Kernel-General 12 (logged on every start).
    $lastStart = $null
    try {
        $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-General'; Id = 12 } -MaxEvents 1 -ErrorAction Stop
        $lastStart = Iso $ev.TimeCreated
    } catch { }
    $fastStartup = $null
    try { $fastStartup = [int](Get-Item 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -ErrorAction Stop).GetValue('HiberbootEnabled') -eq 1 } catch { }

    $memPerf = try { Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop } catch { $null }
    $topProcs = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 |
        ForEach-Object { [ordered]@{ name = $_.ProcessName; mb = [int]($_.WorkingSet64 / 1MB) } })

    $rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
                     (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')

    # Windows Update history (installed OK = Operation 1, ResultCode 2;
    # failed = ResultCode 4). Antivirus definition updates are left out.
    $updates = $null
    try {
        $searcher = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
        $count = $searcher.GetTotalHistoryCount()
        if ($count -gt 0) {
            $hist = @($searcher.QueryHistory(0, [math]::Min($count, 150)) |
                Where-Object {
                    $_.Operation -eq 1 -and
                    $_.Title -notmatch 'Definition|Security Intelligence|Defender Antivirus|Malicious Software Removal' -and
                    $_.Title -notmatch '^[0-9A-Z]{12}-'   # Microsoft Store app updates
                })
            $ok = @($hist | Where-Object { $_.ResultCode -eq 2 } | Sort-Object Date -Descending)
            # Windows itself (monthly cumulative / preview / rollup), not drivers or .NET
            $cu = @($ok | Where-Object {
                ($_.Title -match '^\d{4}-\d{2} .*(Cumulative|Preview|Security) .*Update|Monthly Quality Rollup|Feature update') -and
                $_.Title -notmatch '\.NET|Preparation Package|Servicing Stack'
            }) | Select-Object -First 1
            $since = (Get-Date).ToUniversalTime().AddDays(-30)
            $updates = [ordered]@{
                lastInstalled      = if ($ok.Count) { Iso ([datetime]::SpecifyKind($ok[0].Date, 'Utc')) } else { $null }
                lastTitle          = if ($ok.Count) { $ok[0].Title } else { $null }
                lastCumulative     = if ($cu) { Iso ([datetime]::SpecifyKind($cu.Date, 'Utc')) } else { $null }
                lastCumulativeName = if ($cu) { $cu.Title } else { $null }
                failed30d          = @($hist | Where-Object { $_.ResultCode -eq 4 -and $_.Date -gt $since }).Count
            }
        }
    } catch { }

    $body = [ordered]@{
        computerName    = $env:COMPUTERNAME
        user            = $cs.UserName
        os              = [ordered]@{
            caption        = $os.Caption
            version        = $os.Version
            build          = "$($os.BuildNumber).$($cv.UBR)"
            displayVersion = $cv.DisplayVersion
            installDate    = Iso $os.InstallDate
            lastBoot       = Iso $os.LastBootUpTime
        }
        hardware        = [ordered]@{
            manufacturer = $cs.Manufacturer
            model        = $cs.Model
            serial       = $bios.SerialNumber
            ramGb        = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
            ramFreeGb    = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
            cpu          = $cpu
            volumes      = @($volumes)
            disks        = @($physical)
        }
        windowsLicenses = @($winLic)
        officeLicenses  = @($offLic)
        officeProducts  = @($office)
        clickToRun      = $c2r
        nics            = @($nics)
        security        = [ordered]@{
            products = @($avProducts)
            defender = $defender
            trend    = $trend
        }
        health          = [ordered]@{
            lastStart      = $lastStart
            fastStartup    = $fastStartup
            poolNonPagedMb = if ($memPerf) { [int]($memPerf.PoolNonpagedBytes / 1MB) } else { $null }
            poolPagedMb    = if ($memPerf) { [int]($memPerf.PoolPagedBytes / 1MB) } else { $null }
            commitGb       = if ($memPerf) { [math]::Round($memPerf.CommittedBytes / 1GB, 1) } else { $null }
            commitLimitGb  = if ($memPerf) { [math]::Round($memPerf.CommitLimit / 1GB, 1) } else { $null }
            topProcesses   = @($topProcs)
            rebootPending  = [bool]$rebootPending
            updates        = $updates
        }
        win11           = $win11
    }
    $json = $body | ConvertTo-Json -Depth 6 -Compress

    if ($DryRun) { $body | ConvertTo-Json -Depth 6; return }

    Invoke-RestMethod -Method Post -Uri $ApiUrl -Headers @{ 'X-Report-Token' = $Token } `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60 | Out-Null
    Write-RunLog "OK sent $($json.Length) bytes"
}
catch {
    # Never bother the user; the page shows when a PC last reported.
    Write-RunLog "FAILED at line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"
    exit 1
}
