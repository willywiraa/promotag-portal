<#
  Brings the Promo Tag Portal on this VM up to date from GitHub and makes sure it is running.
  Double-click update-portal.cmd.

    1. Checks GitHub for new commits.
    2. With new commits: stops the portal (never while a run is in progress) and pulls them.
       Without: if the portal is running, nothing else happens.
    3. When package-lock.json changed: removes the old libraries.
    4. Starts the portal (the "Promo Tag Portal" scheduled task, or start-portal.cmd), which installs
       the libraries first when they are missing.

  The other scripts use it with a switch:
    -Background  run-in-background.cmd: from now on the portal runs without a window. The scheduled
                 task starts it when you sign in, and start-portal.cmd /background starts it again if
                 it stops unexpectedly.
    -Stop        stop-portal.cmd: stops the portal (never while a run is in progress).
    -Launch      the scheduled task: starts the portal without a window, unless it is running.

  vm-portal\data (settings, logins, History, the Edge profile) is not in Git and is never touched.
#>
param([switch]$Background, [switch]$Stop, [switch]$Launch)

$ErrorActionPreference = 'Stop'
$vmDir = $PSScriptRoot
$repo = Split-Path -Parent $vmDir
$data = Join-Path $vmDir 'data'
$stateFile = Join-Path $data 'portal.json'
$logFile = Join-Path $data 'portal.log'
$starter = Join-Path $vmDir 'start-portal.cmd'
$taskName = 'Promo Tag Portal'
$tryAgain = if ($Stop) { 'Run stop-portal.cmd again' } elseif ($Background) { 'Run run-in-background.cmd again' } else { 'Run the update again' }

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
    try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($state.port)/" -TimeoutSec 5 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-Runners {
    # start-portal.cmd /background, which starts the portal again when it stops unexpectedly.
    @(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($starter, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match '/background'
    })
}

function Test-Background {
    # run-in-background.cmd set up the scheduled task to start the portal without a window.
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    return [bool]($task -and ($task.Actions | Where-Object { $_.Arguments -match '-Launch' }))
}

function Start-Hidden {
    # start-portal.cmd /background in a console of its own that has no window, so closing a window
    # never stops the portal. Its output goes to data\portal.log.
    $info = New-Object System.Diagnostics.ProcessStartInfo $env:ComSpec, "/d /c `"`"$starter`" /background`""
    $info.WorkingDirectory = $vmDir
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($info) | Out-Null
}

function Start-Portal {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName $taskName
    } else {
        Start-Process -FilePath $starter -WorkingDirectory $vmDir
    }
}

function Stop-Portal {
    $state = $null
    if (Test-Path $stateFile) {
        try { $state = Get-Content $stateFile -Raw | ConvertFrom-Json } catch { }
    }
    if ($state) {
        try {
            Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($state.port)/api/admin/stop" `
                -Headers @{ 'X-PTAE-Stop-Token' = $state.token } -TimeoutSec 15 | Out-Null
        } catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($status -eq 409) { Fail "A run is in progress (or waiting for confirmation). $tryAgain when it has finished." }
            # No answer: the portal is not running or hangs. Both are handled below.
        }
    }
    # The background runner would start the portal again: end it first. Its portal goes on stopping;
    # one that is still starting (no state file yet) is ended with it.
    $runners = @(Get-Runners)
    $starting = @($runners | ForEach-Object { Get-CimInstance Win32_Process -Filter "ParentProcessId = $($_.ProcessId) AND Name = 'node.exe'" })
    $runners | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $proc = $null
    if ($state) { $proc = Get-Process -Id $state.pid -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'node' } }
    if ($proc) {
        $proc | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue
        if (-not $proc.HasExited) {
            Say 'The portal did not stop by itself; ending it.' 'Yellow'
            $proc | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    }
    $starting | Where-Object { -not $state -or $_.ProcessId -ne $state.pid } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    # An Edge left behind by an ended portal would keep the profile locked.
    $profileDir = Join-Path $data 'edge-profile'
    Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item $stateFile -ErrorAction SilentlyContinue
}

function Wait-PortalUp {
    $deadline = (Get-Date).AddSeconds(240)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-PortalUp) { return }
    }
    if (-not (Test-Background)) { Fail 'The portal did not start. Its console window ("Promo Tag Portal") shows why.' }
    if (Test-Path $logFile) {
        Say 'The end of data\portal.log:' 'Yellow'
        Get-Content $logFile -Tail 15 -Encoding UTF8 | ForEach-Object { Say "  $_" 'DarkGray' }
    }
    Fail "The portal did not start. $logFile says why."
}

function Get-Running {
    # "version 1.6.0 at http://localhost:8080/"
    $version = (Get-Content (Join-Path $repo 'hybris-promotag-extension\manifest.json') -Raw | ConvertFrom-Json).version
    return "version $version at http://localhost:$((Get-Content $stateFile -Raw | ConvertFrom-Json).port)/"
}

# --- the scheduled task, at sign-in -----------------------------------------------------------------
if ($Launch) {
    Say 'Starting the Promo Tag Portal in the background...'
    if (-not (Test-PortalUp) -and -not (Get-Runners)) { Start-Hidden }
    exit 0
}

# --- stop-portal.cmd ----------------------------------------------------------------------------------
if ($Stop) {
    if (-not (Test-PortalUp) -and -not (Get-Runners)) {
        Stop-Portal # clears what a portal that crashed may have left behind
        Say 'The portal was not running.' 'Green'
        exit 0
    }
    Say 'Stopping the portal...'
    Stop-Portal
    Say 'The portal is stopped. update-portal.cmd starts it again.' 'Green'
    exit 0
}

# --- run-in-background.cmd ------------------------------------------------------------------------------
if ($Background) {
    Say 'Setting up the portal to run in the background...'
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $script = Join-Path $vmDir 'update-portal.ps1'
    try {
        # In your session ("only when you are signed in"): the portal shows Edge for the SSO sign-in.
        Register-ScheduledTask -TaskName $taskName -Force `
            -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) `
            -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive) `
            -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $vmDir `
                -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Launch") `
            -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
                -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null
    } catch {
        Fail "Windows did not let this account set up the task that starts the portal at sign-in: $($_.Exception.Message)"
    }
    if ((Test-PortalUp) -and (Get-Runners)) {
        Say 'The portal already runs in the background.'
    } else {
        if (Test-PortalUp) { Say 'Restarting the portal without its window...' }
        Stop-Portal # never during a run; the portal's console window closes
        Start-Portal
        Wait-PortalUp
    }
    Say "Done. The portal runs in the background, $(Get-Running) on this VM." 'Green'
    Say ''
    Say '- There is no window to keep open: you can close this one. If the portal stops unexpectedly, it'
    Say '  starts again within a minute.'
    Say '- It starts by itself when you sign in to this VM. To leave the VM, close the Remote Desktop window'
    Say '  with its X. Signing out stops the portal until you sign in again.'
    Say "- Its messages go to $logFile."
    Say '- stop-portal.cmd stops it; update-portal.cmd updates it and starts it again.'
    exit 0
}

# --- update-portal.cmd --------------------------------------------------------------------------------
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
Wait-PortalUp
$done = if ($behind -gt 0) { 'Updated' } else { 'Started' }
$how = if (Test-Background) { ' in the background' } else { '' }
Say "$done. The portal is running$how, $(Get-Running) on this VM." 'Green'
