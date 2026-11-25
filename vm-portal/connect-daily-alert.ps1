# Connects the portal's "Load from Daily Alert" button to the Daily Alert archive. See DEPLOY-VM.md, step 12.
# Asks for the SQL login, tries it with the portal's own query, and saves data\daily-alert.json.
# The password is saved encrypted (Windows DPAPI): only the Windows user running this, on this VM, can
# read it. Run it as the user who runs the portal. Run it again to change the login.
# -Remove deletes the saved login, which hides the button.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$data = Join-Path $PSScriptRoot 'data'
$file = Join-Path $data 'daily-alert.json'

if ($Remove) {
  if (Test-Path $file) { Remove-Item $file; Write-Host 'The Daily Alert login is removed. Reload the portal page: the button is gone.' }
  else { Write-Host 'No Daily Alert login is saved.' }
  return
}

function Read-Value($prompt, $default) {
  $v = Read-Host "$prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}

$old = $null
if (Test-Path $file) { $old = Get-Content $file -Raw | ConvertFrom-Json }
$server = Read-Value 'Database server' $(if ($old) { $old.server } else { '10.100.32.70' })
$database = Read-Value 'Database' $(if ($old) { $old.database } else { 'MasterData' })
$table = Read-Value 'Archive table' $(if ($old -and $old.table) { $old.table } else { 'dbo.DAILY_ALERT_ARCHIVE' })
$user = Read-Value 'SQL login' $(if ($old) { $old.user } else { '' })
if (-not $user) { Write-Host 'A SQL login is needed.' -ForegroundColor Red; exit 1 }
$password = Read-Host 'Password (not shown)' -AsSecureString
if ($password.Length -eq 0) { Write-Host 'No password given: nothing saved.' -ForegroundColor Red; exit 1 }

$config = [ordered]@{
  server = $server
  database = $database
  table = $table
  user = $user
  password = ConvertFrom-SecureString $password
  savedBy = "$env:USERDOMAIN\$env:USERNAME"
  savedAt = (Get-Date).ToString('s')
}
New-Item -ItemType Directory -Force $data | Out-Null
$trial = Join-Path $data 'daily-alert.trial.json'
$config | ConvertTo-Json | Set-Content -LiteralPath $trial -Encoding UTF8

Write-Host "Trying the login on $server ..."
$env:PTAE_ALERT_CONFIG = $trial
$env:PTAE_ALERT_DAYS = '7'
$answer = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'lib\daily-alert-query.ps1') | Select-Object -Last 1
$result = $null
try { $result = $answer | ConvertFrom-Json } catch { }
if (-not $result -or -not $result.ok) {
  Remove-Item -LiteralPath $trial -Force
  $why = if ($result) { $result.error } else { "$answer" }
  Write-Host "It didn't work, so nothing was saved: $why" -ForegroundColor Red
  Write-Host 'Check the login and password, and that this VM reaches the server on port 1433.'
  exit 1
}
Move-Item -LiteralPath $trial -Destination $file -Force
$rows = @($result.rows)
Write-Host "Connected. $($rows.Count) alert line(s) with '||' in the last 7 days." -ForegroundColor Green
$rows | Select-Object -First 5 | ForEach-Object { Write-Host "  $($_.at)  $($_.message)" }
Write-Host ''
Write-Host 'Saved. Reload the portal page: "Load from Daily Alert" appears under the tags.'
