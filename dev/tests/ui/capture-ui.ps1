<#
  Renders the popup views and the History page with stubbed chrome.* APIs and saves screenshots
  to dev\tests\ui\out\ for a visual check.
  Usage:  powershell -ExecutionPolicy Bypass -File dev\tests\ui\capture-ui.ps1
#>
$ErrorActionPreference = 'Stop'
$uiDir = $PSScriptRoot
$outDir = Join-Path $uiDir 'out'
New-Item -ItemType Directory -Force $outDir | Out-Null

$browser = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$profileDir = Join-Path $env:TEMP 'ptae-ui-profile-edge'

function Capture([string]$page, [string]$query, [string]$name, [string]$size) {
    $url = ([System.Uri](Join-Path $uiDir $page)).AbsoluteUri + $query
    $png = Join-Path $outDir "$name.png"
    $argList = @(
        '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--disable-extensions',
        '--allow-file-access-from-files', "--user-data-dir=`"$profileDir`"",
        "--window-size=$size", '--virtual-time-budget=8000', "--screenshot=`"$png`"", "`"$url`""
    )
    $log = Join-Path $env:TEMP "ptae-ui-$name.log"
    Start-Process -FilePath $browser -ArgumentList $argList -NoNewWindow -Wait `
        -RedirectStandardOutput "$log.out" -RedirectStandardError $log | Out-Null
    Write-Host "saved $png"
}

foreach ($view in 'login', 'setup', 'portal', 'settings', 'running', 'confirm', 'result', 'stale') {
    Capture 'popup-preview.html' "?view=$view" "popup-$view" '520,860'
}
Capture 'history-preview.html' '' 'history' '1400,900'
