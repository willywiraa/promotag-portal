<#
  Runs the in-page test suites in headless Microsoft Edge (or Chrome with -Browser chrome) and
  checks that every file the extension references exists.

  Usage:  powershell -ExecutionPolicy Bypass -File dev\tests\run-tests.ps1 [-Filter parser] [-Browser chrome]
#>
param(
    [string]$Filter = '*',
    [ValidateSet('edge', 'chrome')][string]$Browser = 'edge'
)

$ErrorActionPreference = 'Stop'
$testsDir = $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $testsDir)
$ext = Join-Path $repo 'hybris-promotag-extension'
$failures = 0

$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$candidates = if ($Browser -eq 'chrome') { $chrome } else { $edge }
$browserExe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browserExe) { throw "$Browser not found." }
Write-Host "Browser: $browserExe"

# --- 1. Manifest and file references -------------------------------------------------------------
$refs = New-Object System.Collections.Generic.List[string]
$manifest = Get-Content (Join-Path $ext 'manifest.json') -Raw | ConvertFrom-Json
$manifest.icons.PSObject.Properties | ForEach-Object { $refs.Add($_.Value) }
$manifest.action.default_icon.PSObject.Properties | ForEach-Object { $refs.Add($_.Value) }
$refs.Add($manifest.action.default_popup)
$refs.Add($manifest.background.service_worker)

$bg = Get-Content (Join-Path $ext 'scripts\background.js') -Raw
foreach ($m in [regex]::Matches($bg, 'importScripts\(([^)]*)\)')) {
    foreach ($f in [regex]::Matches($m.Groups[1].Value, "'([^']+)'")) { $refs.Add('scripts/' + $f.Groups[1].Value) }
}
foreach ($m in [regex]::Matches($bg, '(?:MAIN_WORLD_FILES|ISOLATED_FILES) = \[([^\]]*)\]')) {
    foreach ($f in [regex]::Matches($m.Groups[1].Value, "'([^']+)'")) { $refs.Add($f.Groups[1].Value) }
}
foreach ($html in 'popup\popup.html', 'history\history.html') {
    $dir = Split-Path (Join-Path $ext $html) -Parent
    $text = Get-Content (Join-Path $ext $html) -Raw
    foreach ($m in [regex]::Matches($text, '(?:src|href)="([^"#:]+)"')) {
        $full = [System.IO.Path]::GetFullPath((Join-Path $dir $m.Groups[1].Value))
        $refs.Add($full.Substring($ext.Length + 1))
    }
}
$unique = $refs | ForEach-Object { $_ -replace '\\', '/' } | Sort-Object -Unique
foreach ($r in $unique) {
    if (-not (Test-Path (Join-Path $ext $r))) {
        Write-Host "FAIL  missing file referenced by the extension: $r" -ForegroundColor Red
        $failures++
    }
}
Write-Host ("Manifest + references: {0} files checked" -f $unique.Count)

# --- 2. Test pages ---------------------------------------------------------------------------------
$profileDir = Join-Path $env:TEMP "ptae-test-profile-$Browser"
$pages = Get-ChildItem -Path $testsDir -Filter "$Filter.test.html" | Sort-Object Name
foreach ($page in $pages) {
    $url = ([System.Uri]$page.FullName).AbsoluteUri
    $outFile = Join-Path $env:TEMP "ptae-$($page.BaseName).out.html"
    $errFile = Join-Path $env:TEMP "ptae-$($page.BaseName).err.txt"
    $argList = @(
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--allow-file-access-from-files',
        "--user-data-dir=`"$profileDir`"", '--virtual-time-budget=300000', '--dump-dom', "`"$url`""
    )
    $proc = Start-Process -FilePath $browserExe -ArgumentList $argList -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile -NoNewWindow -Wait -PassThru
    $dom = Get-Content $outFile -Raw -Encoding UTF8
    if (-not $dom) { $dom = '' }
    $status = ([regex]::Match($dom, 'data-status="(\w+)"')).Groups[1].Value
    $results = [System.Net.WebUtility]::HtmlDecode(([regex]::Match($dom, '<pre id="ptae-test-results">([\s\S]*?)</pre>')).Groups[1].Value)

    if ($status -eq 'pass') {
        Write-Host ("PASS  {0}" -f $page.Name) -ForegroundColor Green
    } else {
        $failures++
        $shown = if ($status) { $status } else { "no result (exit $($proc.ExitCode))" }
        Write-Host ("FAIL  {0}  [{1}]" -f $page.Name, $shown) -ForegroundColor Red
    }
    if ($results) { $results.Trim().Split("`n") | ForEach-Object { Write-Host "      $_" } }
}

if ($failures) {
    Write-Host "`n$failures failure(s)." -ForegroundColor Red
    exit 1
}
Write-Host "`nAll checks passed." -ForegroundColor Green
exit 0
