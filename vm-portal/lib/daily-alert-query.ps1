# Reads recent promo tag alerts from the Daily Alert archive and prints one line of JSON:
#   {"ok":true,"rows":[{"at":"2026-11-24T08:00:01","message":"1088 || ELITE 5 FOR $17.80"}, ...]}
#   {"ok":false,"error":"..."}
# Read-only: one SELECT and nothing else. Used by lib/daily-alert.js (the portal) and by
# connect-daily-alert.ps1 (setup). Input comes from the environment, not parameters, because the portal
# runs this text with -EncodedCommand (no script file, so no execution policy question):
#   PTAE_ALERT_CONFIG  path of data\daily-alert.json (server, database, user, password, optional table)
#   PTAE_ALERT_DAYS    1 = today, 3 = today and the 2 days before, ... (1 to 31)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$conn = $null
try {
  $cfg = Get-Content -LiteralPath $env:PTAE_ALERT_CONFIG -Raw | ConvertFrom-Json
  $days = 3
  if ($env:PTAE_ALERT_DAYS -match '^\d{1,2}$') { $days = [Math]::Min(31, [Math]::Max(1, [int]$env:PTAE_ALERT_DAYS)) }
  $table = 'dbo.DAILY_ALERT_ARCHIVE'
  if ($cfg.table) { $table = [string]$cfg.table }
  if ($table -notmatch '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$') { throw "daily-alert.json: '$table' is not a table name." }

  # The password was saved with ConvertFrom-SecureString: only this Windows user, on this PC, can read it.
  $secure = ConvertTo-SecureString ([string]$cfg.password)
  $secure.MakeReadOnly()
  $cred = New-Object System.Data.SqlClient.SqlCredential ([string]$cfg.user), $secure
  $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $b['Data Source'] = [string]$cfg.server
  $b['Initial Catalog'] = [string]$cfg.database
  $b['Connect Timeout'] = 15
  $b['Application Name'] = 'Promo Tag Portal'
  $conn = New-Object System.Data.SqlClient.SqlConnection $b.ConnectionString, $cred
  $conn.Open()

  # TRY_CONVERT and CAST work whether the columns are dates and text or plain varchar.
  $cmd = $conn.CreateCommand()
  $cmd.CommandTimeout = 30
  $cmd.CommandText = @"
SELECT TOP (500) CONVERT(varchar(19), a.At, 126) AS At, a.Msg
FROM (SELECT TRY_CONVERT(datetime, Alert_Datetime) AS At, CAST(Alert_Message AS nvarchar(4000)) AS Msg FROM $table) a
WHERE a.At >= DATEADD(day, 1 - @days, CAST(GETDATE() AS date)) AND a.Msg LIKE '%||%'
ORDER BY a.At DESC
"@
  [void]$cmd.Parameters.Add('@days', [Data.SqlDbType]::Int)
  $cmd.Parameters['@days'].Value = $days
  $reader = $cmd.ExecuteReader()
  $rows = New-Object System.Collections.ArrayList
  while ($reader.Read()) {
    [void]$rows.Add(@{ at = [string]$reader['At']; message = [string]$reader['Msg'] })
  }
  $reader.Close()
  @{ ok = $true; rows = @($rows) } | ConvertTo-Json -Compress -Depth 4
} catch {
  $msg = $_.Exception.Message -replace '^Exception calling "\w+" with "\d+" argument\(s\): ', '' -replace '^"|"$', ''
  @{ ok = $false; error = $msg } | ConvertTo-Json -Compress
} finally {
  if ($conn) { $conn.Dispose() }
}
