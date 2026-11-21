<#
  backend/scripts/pc/Send-PcReport.ps1

  Runs on every domain PC (deployed by GPO, as SYSTEM, at startup and every
  4 hours) and reports the PC to the IT network page:
    POST https://app.petralu.net/api/network/report   (header X-Report-Token)

  Sends: computer name, logged-on user, Windows edition/build, Windows and
  Office license/activation status (SoftwareLicensingProduct), installed
  Office products (Uninstall registry + Click-to-Run config), NICs (MAC/IP),
  make/model/serial/RAM.

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
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue

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
    $paths = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
             'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    $office = @(Get-ItemProperty $paths -ErrorAction SilentlyContinue |
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
    $cfg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction SilentlyContinue
    if ($cfg) {
        $c2r = [ordered]@{
            productIds = $cfg.ProductReleaseIds
            version    = $cfg.VersionToReport
            platform   = $cfg.Platform
            channel    = if ($cfg.UpdateChannel) { $cfg.UpdateChannel } else { $cfg.CDNBaseUrl }
        }
    }

    $nics = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = TRUE' |
        Where-Object { $_.MACAddress } |
        ForEach-Object {
            [ordered]@{
                mac = $_.MACAddress
                ip  = @($_.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0]
            }
        })

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
        }
        windowsLicenses = @($winLic)
        officeLicenses  = @($offLic)
        officeProducts  = @($office)
        clickToRun      = $c2r
        nics            = @($nics)
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
