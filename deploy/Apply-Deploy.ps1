# Apply-Deploy.ps1 -- the server half of Deploy-Petra.ps1. Runs ON PETRA-APP;
# Deploy-Petra.ps1 copies a fresh copy to C:\Petra\deploy on every deploy.
#
#   -Part info                      prints the backend commit + web version
#   -Part web                       C:\Petra\deploy\web.tar -> C:\Petra\web
#   -Part backend -Sha <commit>     C:\Petra\deploy\backend.bundle -> C:\Petra\backend
#   -NpmCi                          also run npm ci (package-lock.json changed)
#
# Prints APPLY-OK on success; anything else means it failed.

param(
    [ValidateSet('info', 'web', 'backend')][string]$Part,
    [string]$Sha,
    [switch]$NpmCi
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Git = 'C:\Program Files\Git\cmd\git.exe'
$Npm = 'C:\Program Files\nodejs\npm.cmd'
$Backend = 'C:\Petra\backend'
$Web = 'C:\Petra\web'
$Deploy = 'C:\Petra\deploy'
$Service = 'petra-backend'

function Backend-Head { (& $Git -C $Backend rev-parse HEAD | Select-Object -Last 1).Trim() }

function Backend-Up {
    if ((Get-Service $Service).Status -ne 'Running') { return $false }
    try { $null = Get-NetTCPConnection -State Listen -LocalPort 4100 -ErrorAction Stop; return $true }
    catch { return $false }
}

function Wait-BackendUp {
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        if (Backend-Up) { return $true }
    }
    return $false
}

function Npm-Install {
    Push-Location $Backend
    & $Npm ci --omit=dev --no-audit --no-fund
    $ok = ($LASTEXITCODE -eq 0)
    Pop-Location
    return $ok
}

if ($Part -eq 'info') {
    "BACKEND=$(Backend-Head)"
    if (Test-Path "$Web\deploy-version.txt") { "WEB=$((Get-Content "$Web\deploy-version.txt" | Select-Object -First 1).Trim())" }
    else { 'WEB=none' }
    exit 0
}

if ($Part -eq 'web') {
    $new = 'C:\Petra\web-new'
    if (Test-Path $new) { Remove-Item -Recurse -Force $new }
    New-Item -ItemType Directory $new | Out-Null
    & tar.exe -xf "$Deploy\web.tar" -C $new
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$new\index.html")) { 'Unpacking the web pages failed.'; exit 1 }

    # Keep the current version so it can be put back by hand if needed.
    & robocopy.exe $Web 'C:\Petra\web-prev' /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { 'Backing up the current web pages failed.'; exit 1 }
    & robocopy.exe $new $Web /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { 'Copying the new web pages failed -- previous version is in C:\Petra\web-prev.'; exit 1 }

    Remove-Item -Recurse -Force $new
    Remove-Item -Force "$Deploy\web.tar"
    "Web pages updated ($((Get-ChildItem -Recurse -File $Web).Count) files)."
    'APPLY-OK web'
    exit 0
}

# ---- backend
if (-not $Sha) { 'Missing -Sha.'; exit 1 }
$old = Backend-Head
$wasRunning = ((Get-Service $Service).Status -eq 'Running')

function Roll-Back($why) {
    "$why -- rolling back to $($old.Substring(0,7))."
    & $Git -C $Backend reset --hard $old | Out-Null
    if ($NpmCi) { $null = Npm-Install }
    if ($wasRunning) {
        Start-Service $Service
        if (Wait-BackendUp) { 'Previous version is running again.' } else { 'WARNING: previous version did not come back up either -- check C:\Petra\logs.' }
    }
    exit 1
}

if ($wasRunning) {
    'Stopping petra-backend...'
    Stop-Service $Service
}

& $Git -C $Backend fetch --quiet "$Deploy\backend.bundle" HEAD
if ($LASTEXITCODE -ne 0) { Roll-Back 'Reading the code bundle failed' }
& $Git -C $Backend reset --hard FETCH_HEAD | Out-Null
if ((Backend-Head) -ne $Sha) { Roll-Back 'The code on the server did not end up at the expected commit' }
"Code updated: $($old.Substring(0,7)) -> $($Sha.Substring(0,7))"

if ($NpmCi) {
    'Installing packages (npm ci)...'
    if (-not (Npm-Install)) { Roll-Back 'npm ci failed' }
}

if ($wasRunning) {
    'Starting petra-backend...'
    Start-Service $Service
    if (-not (Wait-BackendUp)) {
        'The backend did not come up. Last log lines:'
        Get-Content 'C:\Petra\logs\petra-backend.err.log' -Tail 15 -ErrorAction SilentlyContinue
        Get-Content 'C:\Petra\logs\petra-backend.out.log' -Tail 15 -ErrorAction SilentlyContinue
        Stop-Service $Service -ErrorAction SilentlyContinue
        Roll-Back 'Backend failed to start'
    }
    'petra-backend is running.'
} else {
    'petra-backend was stopped before the deploy -- left stopped (start it with: Start-Service petra-backend).'
}

Remove-Item -Force "$Deploy\backend.bundle" -ErrorAction SilentlyContinue
"APPLY-OK backend $Sha"
exit 0
