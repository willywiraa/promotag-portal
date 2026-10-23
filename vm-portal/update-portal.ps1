<#
  Brings the Promo Tag Portal on this VM up to date from GitHub and makes sure it is running.
  Double-click update-portal.cmd.

    1. Checks GitHub for new commits.
    2. With new commits: stops the portal (never while a run is in progress) and pulls them.
       Without: if the portal is running, nothing else happens.
    3. When package-lock.json changed: removes the old libraries.
    4. Starts the portal (the "Promo Tag Portal" scheduled task, or start-portal.cmd), which installs
       the libraries first when they are missing.

  vm-portal\data (settings, logins, History, the Edge profile) is not in Git and is never touched.
#>
$ErrorActionPreference = 'Stop'
$vmDir = $PSScriptRoot
$repo = Split-Path -Parent $vmDir
$data = Join-Path $vmDir 'data'
$stateFile = Join-Path $data 'portal.json'
$taskName = 'Promo Tag Portal'

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Fail([string]$text) {
    Write-Host $text -ForegroundColor Red
    exit 1
}

function Invoke-Git {
    # Runs git in the repository and returns its output, including error lines; the exit code stays
    # in $LASTEXITCODE. (Windows PowerShell would stop on git's error output under 'Stop'.)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return @(& git -C $repo @args 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $previous }
}

function Test-PortalUp {
    if (-not (Test-Path $stateFile)) { return $false }
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($state.port)/" -TimeoutSec 5 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Start-Portal {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName $taskName
    } else {
        Start-Process -FilePath (Join-Path $vmDir 'start-portal.cmd') -WorkingDirectory $vmDir
    }
}

function Stop-Portal {
    if (-not (Test-Path $stateFile)) { return }
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    try {
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($state.port)/api/admin/stop" `
            -Headers @{ 'X-PTAE-Stop-Token' = $state.token } -TimeoutSec 15 | Out-Null
    } catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 409) { Fail 'A run is in progress (or waiting for confirmation). Run the update again when it has finished.' }
        # No answer: the portal is not running or hangs. Both are handled below.
    }
    $proc = Get-Process -Id $state.pid -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'node' }
    if ($proc) {
        $proc | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue
        if (-not $proc.HasExited) {
            Say 'The portal did not stop by itself; ending it.' 'Yellow'
            $proc | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    }
    # An Edge left behind by an ended portal would keep the profile locked.
    $profileDir = Join-Path $data 'edge-profile'
    Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item $stateFile -ErrorAction SilentlyContinue
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git is not installed. Install Git for Windows first (DEPLOY-VM.md).' }

# 1. Anything new on GitHub?
Say 'Checking GitHub for updates...'
$out = Invoke-Git fetch --quiet origin
if ($LASTEXITCODE -and ($out -join "`n") -match 'dubious ownership') {
    # The folder belongs to another account (e.g. cloned as administrator). It holds this very
    # script, so trusting it for the current account adds no risk.
    Say 'Git does not trust this folder yet (it belongs to another account). Trusting it for your account...' 'Yellow'
    & git config --global --add safe.directory ($repo -replace '\\', '/')
    $out = Invoke-Git fetch --quiet origin
}
if ($LASTEXITCODE) {
    $out | ForEach-Object { Say "  $_" 'DarkGray' }
    Fail 'Could not get the updates from GitHub (Git''s message is above). Check the internet access and the GitHub token on this VM.'
}
$branch = (& git -C $repo rev-parse --abbrev-ref HEAD).Trim()
$behind = [int](& git -C $repo rev-list --count "HEAD..origin/$branch")
$librariesChanged = $false
if ($behind -gt 0) {
    $edited = & git -C $repo status --porcelain --untracked-files=no
    if ($edited) {
        Fail ("These files were changed on this VM; the update would overwrite them:`n$($edited -join "`n")`n" +
            "Undo the changes with: git -C `"$repo`" checkout -- .`nThen run the update again.")
    }
    Say "$behind new change(s):"
    & git -C $repo log --oneline "HEAD..origin/$branch" | ForEach-Object { Say "  $_" }
    $librariesChanged = [bool](& git -C $repo diff --name-only HEAD "origin/$branch" -- vm-portal/package-lock.json)

    # 2. Stop the portal, then pull
    Say 'Stopping the portal...'
    Stop-Portal
    & git -C $repo merge --ff-only --quiet "origin/$branch"
    if ($LASTEXITCODE) {
        Start-Portal
        Fail 'The update could not be applied (see above). The portal was started again with the previous version.'
    }
} elseif (Test-PortalUp) {
    Say 'Already up to date. The portal is running.' 'Green'
    exit 0
} else {
    Say 'Already up to date, but the portal is not running.' 'Yellow'
    Stop-Portal # clears what a portal that crashed may have left behind
}

# 3. Changed libraries: remove the old ones. start-portal.cmd installs the new ones (with the proxy
#    settings from data\env.cmd), so installing happens in one place.
$modules = Join-Path $vmDir 'node_modules'
if ($librariesChanged -and (Test-Path $modules)) {
    Say 'The libraries changed; removing the old ones.'
    & cmd /c rd /s /q "\\?\$modules"
}

# 4. Start the portal
if (Test-Path (Join-Path $modules 'playwright-core\package.json')) {
    Say 'Starting the portal...'
} else {
    Say 'Starting the portal. It installs its libraries first; this takes a minute...'
}
Start-Portal
$deadline = (Get-Date).AddSeconds(240)
$up = $false
while (-not $up -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $up = Test-PortalUp
}
if (-not $up) { Fail 'The portal did not start. Its console window ("Promo Tag Portal") shows why.' }
$version = (Get-Content (Join-Path $repo 'hybris-promotag-extension\manifest.json') -Raw | ConvertFrom-Json).version
$done = if ($behind -gt 0) { 'Updated' } else { 'Started' }
Say "$done. The portal is running version $version. Open http://localhost:$((Get-Content $stateFile -Raw | ConvertFrom-Json).port)/ on this VM." 'Green'
