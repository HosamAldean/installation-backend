# Deploy-Petra.ps1 -- push the live code from this PC to the PETRA-APP server.
# Run C:\IA\backend\deploy\Deploy-Petra.exe (rebuild the exe from src\ with
# the .NET Framework csc.exe if DeployPetra.cs changes). Logs go to deploy\logs.
#
# Deploys what is COMMITTED on the branches checked out in C:\IA\backend and
# C:\IA\frontend (uncommitted changes are never sent). Develop and test on
# this PC first, merge into the live branch, then run this.
#
#   Deploy-Petra.exe                  backend + web pages
#   Deploy-Petra.exe -BackendOnly
#   Deploy-Petra.exe -FrontendOnly
#   Deploy-Petra.exe -Yes             no "Deploy? (y/n)" question
#
# Backend: sends only the new git commits (git bundle) -> stops the
# petra-backend service -> updates the code -> runs `npm ci` only when
# package-lock.json changed -> starts it again. If the backend doesn't come
# back up, it rolls back to the previous commit by itself. A service that
# was stopped before the deploy is left stopped.
#
# Web pages: built in C:\IA\frontend-deploy (a clean copy with no .env.local,
# so the build uses relative URLs that work on app.petralu.net), then copied
# to C:\Petra\web. The previous version is kept in C:\Petra\web-prev.
#
# Database migrations are NOT run -- those stay a separate, confirmed step.

param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly,
    [switch]$Yes
)

# 'Continue', not 'Stop': in PowerShell 5.1 a native tool writing progress to
# stderr (git, ssh) would otherwise abort the script. Every step checks
# $LASTEXITCODE itself and calls Fail.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$VM = 'Administrator@192.168.20.88'
$BackendRepo = 'C:\IA\backend'
$FrontendRepo = 'C:\IA\frontend'
$BuildTree = 'C:\IA\frontend-deploy'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Work = Join-Path $env:TEMP 'petra-deploy'
$LogDir = Join-Path $Here 'logs'

$doBackend = -not $FrontendOnly
$doFrontend = -not $BackendOnly

New-Item -ItemType Directory -Force $Work, $LogDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir ("deploy-{0:yyyy-MM-dd_HH-mm}.log" -f (Get-Date))) | Out-Null

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ''; Write-Host "FAILED: $text" -ForegroundColor Red; Stop-Transcript | Out-Null; exit 1 }

function Git-Local {
    $out = & git @args 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "git $($args -join ' '): $out" }
    return $out
}

# Runs a one-line command on the server and returns its output.
function On-VM($command) {
    $out = & ssh -o BatchMode=yes -o ConnectTimeout=15 $VM $command 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "server command failed: $command`n$out" }
    return $out
}

function Send-File($local, $remote) {
    & scp -q -o BatchMode=yes $local "${VM}:$remote"
    if ($LASTEXITCODE -ne 0) { Fail "copy to server failed: $local" }
}

# -------------------------------------------------------------- checks

Step 'Checking the server connection'
$null = On-VM 'hostname'
Write-Host 'PETRA-APP reachable.'
On-VM 'New-Item -ItemType Directory -Force C:\Petra\deploy | Out-Null' | Out-Null
Send-File (Join-Path $Here 'Apply-Deploy.ps1') 'C:/Petra/deploy/Apply-Deploy.ps1'
# (No quotes in server commands -- they don't survive ssh from PowerShell 5.1.)
$info = On-VM 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Petra\deploy\Apply-Deploy.ps1 -Part info'
$vmSha = (($info | Where-Object { "$_" -like 'BACKEND=*' }) -replace '^BACKEND=', '').Trim()
$vmWeb = (($info | Where-Object { "$_" -like 'WEB=*' }) -replace '^WEB=', '').Trim()
if ($vmSha -notmatch '^[0-9a-f]{40}$') { Fail "could not read the server's backend version: $info" }

$plan = @()

if ($doBackend) {
    $beBranch = Git-Local -C $BackendRepo rev-parse --abbrev-ref HEAD
    $beSha = Git-Local -C $BackendRepo rev-parse HEAD
    $dirty = & git -C $BackendRepo status --porcelain --untracked-files=no
    if ($dirty) { Write-Host "Note: C:\IA\backend has uncommitted changes -- they will NOT be deployed." -ForegroundColor Yellow }

    if ($vmSha -eq $beSha) {
        Write-Host "Backend: server already has $($beSha.Substring(0,7)) -- nothing to send."
        $doBackend = $false
    } else {
        & git -C $BackendRepo cat-file -e "$vmSha^{commit}" 2>$null
        $known = ($LASTEXITCODE -eq 0)
        $plan += "BACKEND  $beBranch  $($vmSha.Substring(0,7)) -> $($beSha.Substring(0,7))"
        if ($known) {
            $plan += (& git -C $BackendRepo log --oneline --no-merges "$vmSha..$beSha" | Select-Object -First 25 | ForEach-Object { "    $_" })
            $changed = & git -C $BackendRepo diff --name-only $vmSha $beSha
            $npmCi = [bool]($changed | Where-Object { $_ -match '^package(-lock)?\.json$' })
            $migrations = $changed | Where-Object { $_ -match '^(scripts|migrations)/' }
            if ($npmCi) { $plan += '    (package-lock.json changed -> npm ci on the server, about 1 minute)' }
            if ($migrations) {
                $plan += '    NOTE: new/changed scripts -- run any needed migration separately:'
                $plan += ($migrations | ForEach-Object { "      $_" })
            }
        } else {
            $npmCi = $true
            $plan += '    (server commit unknown on this PC -> full copy + npm ci)'
        }
    }
}

if ($doFrontend) {
    $feBranch = Git-Local -C $FrontendRepo rev-parse --abbrev-ref HEAD
    $feSha = Git-Local -C $FrontendRepo rev-parse HEAD
    $dirty = & git -C $FrontendRepo status --porcelain --untracked-files=no
    if ($dirty) { Write-Host "Note: C:\IA\frontend has uncommitted changes -- they will NOT be deployed." -ForegroundColor Yellow }

    if ($vmWeb -eq $feSha) {
        Write-Host "Web pages: server already has $($feSha.Substring(0,7)) -- nothing to send."
        $doFrontend = $false
    } else {
        $from = if ($vmWeb -eq 'none') { 'unknown' } else { $vmWeb.Substring(0,7) }
        $plan += "WEB      $feBranch  $from -> $($feSha.Substring(0,7))"
        if ($vmWeb -ne 'none') {
            & git -C $FrontendRepo cat-file -e "$vmWeb^{commit}" 2>$null
            if ($LASTEXITCODE -eq 0) {
                $plan += (& git -C $FrontendRepo log --oneline --no-merges "$vmWeb..$feSha" | Select-Object -First 25 | ForEach-Object { "    $_" })
            }
        }
    }
}

if (-not $doBackend -and -not $doFrontend) {
    Write-Host ''
    Write-Host 'Everything is already up to date. Nothing to deploy.' -ForegroundColor Green
    Stop-Transcript | Out-Null
    exit 0
}

Step 'What will be deployed'
$plan | ForEach-Object { Write-Host $_ }
if (-not $Yes) {
    Write-Host ''
    $answer = Read-Host 'Deploy to PETRA-APP now? (y/n)'
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Cancelled. Nothing was changed.'; Stop-Transcript | Out-Null; exit 0 }
}

# -------------------------------------------------------------- web pages
# Built before the backend is touched, so a build error stops everything
# while the server is still untouched.

if ($doFrontend) {
    Step 'Building the web pages'
    if (-not (Test-Path $BuildTree)) {
        Git-Local -C $FrontendRepo worktree add --detach $BuildTree $feSha | Out-Null
        cmd /c mklink /J "$BuildTree\node_modules" "$FrontendRepo\node_modules" | Out-Null
    }
    Git-Local -C $BuildTree checkout --force --detach $feSha | Out-Null
    # Local-only env files would bake this PC's addresses into the build.
    Get-ChildItem $BuildTree -Filter '.env*' -Force | Where-Object { $_.Name -notmatch 'example' } | Remove-Item -Force
    if (Test-Path "$BuildTree\dist") { Remove-Item -Recurse -Force "$BuildTree\dist" }

    Push-Location $BuildTree
    try {
        # packages/shared is its own repo (C:\IA\packages), reached through the
        # node_modules junction and already built by the dev setup -- only
        # the Vite step runs here (`pnpm run build` would try to rebuild
        # shared inside this copy, without its node_modules).
        & cmd /c 'pnpm exec vite build'
        if ($LASTEXITCODE -ne 0) { Fail 'web build failed (see the errors above). The server was not changed.' }
    } finally { Pop-Location }
    if (-not (Test-Path "$BuildTree\dist\index.html")) { Fail 'build produced no dist\index.html. The server was not changed.' }
    Set-Content -Path "$BuildTree\dist\deploy-version.txt" -Value $feSha -Encoding ASCII

    $webTar = Join-Path $Work 'web.tar'
    if (Test-Path $webTar) { Remove-Item $webTar }
    & "$env:SystemRoot\System32\tar.exe" -cf $webTar -C "$BuildTree\dist" .
    if ($LASTEXITCODE -ne 0) { Fail 'packing the web build failed.' }

    Step 'Copying the web pages to the server'
    Send-File $webTar 'C:/Petra/deploy/web.tar'
    $out = On-VM 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Petra\deploy\Apply-Deploy.ps1 -Part web'
    $out | ForEach-Object { Write-Host $_ }
    if (-not ($out -match 'APPLY-OK')) { Fail 'updating the web pages on the server failed.' }
}

# -------------------------------------------------------------- backend

if ($doBackend) {
    Step 'Sending the backend code'
    $bundle = Join-Path $Work 'backend.bundle'
    if (Test-Path $bundle) { Remove-Item $bundle }
    if ($known) { Git-Local -C $BackendRepo bundle create $bundle HEAD "^$vmSha" | Out-Null }
    else { Git-Local -C $BackendRepo bundle create $bundle HEAD | Out-Null }
    Send-File $bundle 'C:/Petra/deploy/backend.bundle'

    Step 'Updating and restarting the backend'
    $npmArg = if ($npmCi) { ' -NpmCi' } else { '' }
    $out = On-VM "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Petra\deploy\Apply-Deploy.ps1 -Part backend -Sha $beSha$npmArg"
    $out | ForEach-Object { Write-Host $_ }
    if (-not ($out -match 'APPLY-OK')) { Fail 'backend update failed -- see above (the server rolled back to the previous version).' }
}

# -------------------------------------------------------------- check

Step 'Checking https://app.petralu.net'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
foreach ($url in 'https://app.petralu.net/', 'https://app.petralu.net/api/auth/me') {
    try {
        $code = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20).StatusCode
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $_.Exception.Message }
    }
    Write-Host ("{0,-40} {1}" -f $url, $code)
}
Write-Host '(page = 200 is good; /api/auth/me = 401 means the backend is up, 502 means it is stopped)'

Write-Host ''
Write-Host 'Deploy finished.' -ForegroundColor Green
Stop-Transcript | Out-Null
exit 0
