param(
  [string]$RemoteDatabaseUrl = "",
  [string]$LocalDatabaseUrl = "",
  [string]$BackupDir = "backups\db",
  [string[]]$RestoreSchema = @("public"),
  [switch]$SkipLocalBackup,
  [switch]$SkipSchema,
  [switch]$Yes,
  [switch]$InstallDailyTask,
  [string]$At = "06:00"
)

$ErrorActionPreference = "Stop"

function Import-DotEnvFile {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#") -or !$line.Contains("=")) { return }
    $parts = $line.Split("=", 2)
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ($key -and -not [Environment]::GetEnvironmentVariable($key, "Process")) {
      [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
  }
}

function Find-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $scoopPath = Join-Path $env:USERPROFILE "scoop\apps\postgresql\current\bin\$Name.exe"
  if (Test-Path -LiteralPath $scoopPath) { return $scoopPath }
  throw "Could not find $Name. Install PostgreSQL client tools or add them to PATH."
}

function Redact-DatabaseUrl {
  param([string]$Url)
  try {
    $uri = [Uri]$Url
    $db = $uri.AbsolutePath.TrimStart("/")
    $port = ""
    if (!$uri.IsDefaultPort) { $port = ":$($uri.Port)" }
    return "$($uri.Scheme)://$($uri.Host)$port/$db"
  } catch {
    return "invalid database URL"
  }
}

function Get-DatabaseName {
  param([string]$Url)
  $uri = [Uri]$Url
  $db = $uri.AbsolutePath.TrimStart("/")
  if (!$db) { throw "DATABASE_URL must include a database name." }
  return [Uri]::UnescapeDataString($db)
}

function Get-MaintenanceUrl {
  param([string]$Url)
  $uri = [Uri]$Url
  $builder = [UriBuilder]::new($uri)
  $builder.Path = "postgres"
  return $builder.Uri.AbsoluteUri
}

function Quote-Identifier {
  param([string]$Name)
  return '"' + $Name.Replace('"', '""') + '"'
}

function Assert-LocalDatabaseUrl {
  param([string]$Url)
  $uri = [Uri]$Url
  $localHosts = @("localhost", "127.0.0.1", "::1")
  if ($localHosts -notcontains $uri.Host) {
    throw "Refusing to overwrite non-local database target: $(Redact-DatabaseUrl $Url)"
  }
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$Label
  )
  Write-Host "==> $Label"
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Import-DotEnvFile (Join-Path $repoRoot ".env.local")
Import-DotEnvFile (Join-Path $repoRoot ".env")

if (!$RemoteDatabaseUrl) {
  $RemoteDatabaseUrl = $env:DCC_REMOTE_DATABASE_URL
}
if (!$RemoteDatabaseUrl) {
  $RemoteDatabaseUrl = $env:REMOTE_DATABASE_URL
}
if (!$LocalDatabaseUrl) {
  $LocalDatabaseUrl = $env:DATABASE_URL
}

if ($InstallDailyTask) {
  $scriptPath = Join-Path $PSScriptRoot "refresh-local-db.ps1"
  $time = [DateTime]::ParseExact($At, "HH:mm", $null)
  $taskName = "Daily Command Center local DB refresh"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Yes"
  $trigger = New-ScheduledTaskTrigger -Daily -At $time
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description "Refresh the local Daily Command Center Postgres database from the configured remote snapshot." -Force | Out-Null
  Write-Host "Installed scheduled task '$taskName' for $At daily."
  Write-Host "Make sure DCC_REMOTE_DATABASE_URL is available in .env.local before the task runs."
  exit 0
}

if (!$RemoteDatabaseUrl) {
  throw "Missing remote database URL. Set DCC_REMOTE_DATABASE_URL in your shell or in .env.local."
}
if (!$LocalDatabaseUrl) {
  throw "Missing local DATABASE_URL. Set DATABASE_URL in .env or your shell."
}
if ($RemoteDatabaseUrl -eq $LocalDatabaseUrl) {
  throw "Remote and local database URLs are identical. Refusing to continue."
}

Assert-LocalDatabaseUrl $LocalDatabaseUrl

$pgDump = Find-CommandPath "pg_dump"
$pgRestore = Find-CommandPath "pg_restore"
$psql = Find-CommandPath "psql"

$localDbName = Get-DatabaseName $LocalDatabaseUrl
$maintenanceUrl = Get-MaintenanceUrl $LocalDatabaseUrl
$quotedDbName = Quote-Identifier $localDbName
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = Join-Path $repoRoot $BackupDir
New-Item -ItemType Directory -Force -Path $backupPath | Out-Null

$remoteDump = Join-Path $backupPath "remote-$timestamp.dump"
$localBackup = Join-Path $backupPath "local-before-refresh-$timestamp.dump"

Write-Host "Remote: $(Redact-DatabaseUrl $RemoteDatabaseUrl)"
Write-Host "Local:  $(Redact-DatabaseUrl $LocalDatabaseUrl)"
Write-Host ""
Write-Host "This will replace local database '$localDbName'."
if (!$Yes) {
  $answer = Read-Host "Type REFRESH to continue"
  if ($answer -ne "REFRESH") {
    Write-Host "Cancelled."
    exit 1
  }
}

Invoke-Checked $pgDump @("--format=custom", "--no-owner", "--no-acl", "--file=$remoteDump", $RemoteDatabaseUrl) "Dump remote database"

if (!$SkipLocalBackup) {
  try {
    Invoke-Checked $pgDump @("--format=custom", "--no-owner", "--no-acl", "--file=$localBackup", $LocalDatabaseUrl) "Back up current local database"
  } catch {
    Write-Warning "Local backup failed. Continuing because the local database may not exist yet. Details: $($_.Exception.Message)"
  }
}

$terminateSql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$($localDbName.Replace("'", "''"))' AND pid <> pg_backend_pid();"
Invoke-Checked $psql @($maintenanceUrl, "-v", "ON_ERROR_STOP=1", "-c", $terminateSql, "-c", "DROP DATABASE IF EXISTS $quotedDbName;", "-c", "CREATE DATABASE $quotedDbName;") "Recreate local database"

$restoreArgs = @("--no-owner", "--no-acl", "--dbname=$LocalDatabaseUrl")
foreach ($schema in $RestoreSchema) {
  if ($schema) { $restoreArgs += "--schema=$schema" }
}
$restoreArgs += $remoteDump
Invoke-Checked $pgRestore $restoreArgs "Restore remote dump into local database"

if (!$SkipSchema) {
  Invoke-Checked "node" @("pg-schema.js") "Apply local schema updates"
}

Write-Host ""
Write-Host "Local database refresh complete."
Write-Host "Remote dump: $remoteDump"
if (!$SkipLocalBackup) {
  Write-Host "Local backup: $localBackup"
}
