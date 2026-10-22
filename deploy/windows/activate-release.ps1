<#
.SYNOPSIS
Makes a staged release the one the services run, and puts the previous one
back if it does not come up.

.DESCRIPTION
Steps 3 to 9 of docs/deployment-model.md. The ordering is the point: every
step before the junction switch is reversible by doing nothing, and the switch
itself is a single rename.

The invariant this script exists to keep:

    the database's schema must be current
            BEFORE
    code that requires it is activated

and its less obvious corollary — the migration must be run by the *new*
release's migrator, because the new release is what ships the migration files.
So step 4 runs node from the staged release directory, not from whatever is
currently serving.

Rollback restores the code, not the schema. Migrations are additive across a
rollback by design; a migration that removes what the previous version reads
would make this script's recovery path a lie.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $Version,

  [string] $AppRoot = 'C:\ProgramData\Seyirlik\app',
  [string] $ConfigDir = 'C:\ProgramData\Seyirlik\config',
  [string] $SecretsDir = 'C:\ProgramData\Seyirlik\secrets',
  [string] $BackupRoot = 'C:\ProgramData\Seyirlik\backups',
  [string] $Nssm = 'C:\Program Files\Seyirlik\bin\nssm.exe',
  [string] $PgDump = 'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe',
  [string] $HealthUrl = 'http://127.0.0.1:43111/ownAPI/v1/health',

  # Service names, so a rehearsal can drive disposable services instead of
  # production ones.
  [string] $ServerService = 'SeyirlikServer',
  [string] $WorkerService = 'SeyirlikWorker'
)

$ErrorActionPreference = 'Stop'

# Each phase reports its own time, so a slow deployment says where it was slow.
$phaseClock = [Diagnostics.Stopwatch]::StartNew()
function Write-Phase([string] $Name) {
  Write-Output ("PHASE={0}:{1:0.0}s" -f $Name, $phaseClock.Elapsed.TotalSeconds)
  $phaseClock.Restart()
}

$releases = Join-Path $AppRoot 'releases'
$target = Join-Path $releases $Version
$current = Join-Path $AppRoot 'current'

if (-not (Test-Path -LiteralPath (Join-Path $target 'RELEASE.json'))) {
  throw "no staged release at $target (stage it first)"
}

# Staging checked this release, but a crash since then can zero-fill files it
# had not yet written out, and staging and activation are not always one
# session. Checked again here, before anything else: step 4 runs this release's
# own migrator, and a damaged migration file must not get as far as the
# database, let alone the junction.
<#
Reading every file again is only needed if the release could have changed
since staging checked it, and the only thing that zero-fills a file is a crash
before the write reached the disk. Staging flushes first, checks second, and
records the boot it did both in. While this is still that boot there has been
no crash, so the record stands in for the read, which on this host is about
seven minutes of first opens. Any doubt (no record, an unreadable one, a
different boot) reads every file, exactly as before.
#>
$staged = $null
$integrityRecord = Join-Path $target 'INTEGRITY.json'
if (Test-Path -LiteralPath $integrityRecord) {
  try {
    $record = Get-Content -LiteralPath $integrityRecord -Raw | ConvertFrom-Json
    $bootTicks = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks
    if ([long]$record.bootTicks -eq $bootTicks -and [int]$record.checkedFiles -gt 0) { $staged = $record }
  }
  catch { $staged = $null }
}
if ($staged) {
  Write-Output ("VERIFIED_FILES={0} (checked at staging, {1}, in this boot)" -f $staged.checkedFiles, $staged.verifiedAt)
}
else {
  . (Join-Path $PSScriptRoot 'release-integrity.ps1')
  $integrity = Find-ZeroFilledFiles $target
  if ($integrity.Damaged.Count -gt 0) {
    throw ("release $Version has $($integrity.Damaged.Count) zero-filled file(s); refusing to activate it, nothing has been switched:`n" + ($integrity.Damaged -join "`n"))
  }
  Write-Output ("VERIFIED_FILES=" + $integrity.Checked)
}
Write-Phase 'verify'

function Get-SvcState([string] $n) {
  $s = Get-CimInstance Win32_Service -Filter "Name='$n'" -ErrorAction SilentlyContinue
  if ($s) { $s.State } else { $null }
}

function Wait-Svc([string] $n, [string] $want, [int] $secs = 90) {
  for ($i = 0; $i -lt $secs; $i++) {
    if ((Get-SvcState $n) -eq $want) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# The junction is the pointer the services resolve. Reading where it points is
# how rollback knows what to go back to.
function Get-CurrentTarget {
  if (-not (Test-Path -LiteralPath $current)) { return $null }
  (Get-Item -LiteralPath $current -Force).Target | Select-Object -First 1
}

function Set-Current([string] $to) {
  # Remove-Item on a junction removes the link, not what it points at, but
  # only when the path is not treated as a directory to recurse into. -Force
  # without -Recurse is the form that stays on the link itself.
  if (Test-Path -LiteralPath $current) { (Get-Item -LiteralPath $current -Force).Delete() }
  New-Item -ItemType Junction -Path $current -Target $to | Out-Null
}

<#
What to go back to is not always a previous release. The first activation
replaces a git checkout, and a rollback that only knew about junctions would
have nothing to say — it would leave the services pointed at a release that
just failed to start.

So rollback restores the two things the switch changes: where `current` points,
and what the services call their working directory. Recording the second from
the registry covers the checkout case and the junction case with one path.
#>
function Get-AppDirectory([string] $service) {
  (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$service\Parameters" -ErrorAction SilentlyContinue).AppDirectory
}

$previous = Get-CurrentTarget
$previousAppDir = @{
  $ServerService = Get-AppDirectory $ServerService
  $WorkerService = Get-AppDirectory $WorkerService
}
Write-Output "PREVIOUS_RELEASE=$previous"
Write-Output ("PREVIOUS_APPDIR=" + $previousAppDir[$ServerService])

# --- 3. backup -------------------------------------------------------------
# Before anything irreversible, and covering the two environment files as well
# as the database, because a rollback that restored the schema but not the
# configuration would be a different system.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $BackupRoot "release-$Version-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null

$url = $null
foreach ($line in Get-Content (Join-Path $SecretsDir 'secrets.env')) {
  if ($line -match '^\s*DATABASE_URL\s*=\s*(.+?)\s*$') { $url = $Matches[1].Trim().Trim('"') }
}
if (-not $url) { throw 'DATABASE_URL not found in secrets.env' }

# Each of these has to be one argument. PowerShell does not join a bare
# token to a parenthesised expression that follows it — it passes two — so
# the path is built before the call rather than inside it.
$dumpFile = Join-Path $backup 'seyirlik.dump'
& $PgDump "--dbname=$url" '--format=custom' "--file=$dumpFile"
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed; refusing to continue without a backup' }
Copy-Item (Join-Path $ConfigDir 'settings.env') $backup
Copy-Item (Join-Path $SecretsDir 'secrets.env') $backup
Write-Output ("BACKUP=" + $backup)
Write-Phase 'backup'

$settingsArg = '--env-file=' + (Join-Path $ConfigDir 'settings.env')
$secretsArg = '--env-file=' + (Join-Path $SecretsDir 'secrets.env')

# --- 4. migrate, with the new release's migrator ---------------------------
Push-Location $target
try {
  & node $settingsArg $secretsArg --import tsx scripts/run-own-api-migrations.ts
  if ($LASTEXITCODE -ne 0) { throw 'migration failed; nothing has been switched' }
}
finally { Pop-Location }

# --- 5. verify the schema is current ---------------------------------------
# Re-running the migrator is the check: it validates every recorded checksum
# against the files this release ships and refuses on a mismatch, so a second
# clean pass means current *and* unaltered.
Push-Location $target
try {
  & node $settingsArg $secretsArg --import tsx scripts/run-own-api-migrations.ts
  if ($LASTEXITCODE -ne 0) { throw 'schema did not verify as current; nothing has been switched' }
}
finally { Pop-Location }
Write-Phase 'migrate'

# --- 5b. prove the new worker would start ----------------------------------
# The running worker is not restarted below: it leaves its release on its own
# once `current` names another one, after the job it holds (releaseHandoff.ts).
# So a worker that cannot start must be caught here, while `current` still
# names the old release; afterwards it would only be found by a worker that
# exits and does not come back. Loads the whole module graph, reads the
# worker's configuration and checks the schema, then exits.
Push-Location $target
try {
  & node $settingsArg $secretsArg --import tsx src/server/mediaWorker.ts --check
  if ($LASTEXITCODE -ne 0) { throw "the new release's worker would not start; nothing has been switched" }
}
finally { Pop-Location }
Write-Phase 'worker-check'

# --- 6. switch -------------------------------------------------------------
# A worker on a release that hands itself over is left running: switching the
# junction is the whole of its deployment, and the job it holds finishes on the
# code it started with. One on an older release does not know to look, so it
# is stopped and started around the switch as before — once, for the first
# release that carries the hand-off.
$workerHandsOff = $previous -and
  (Test-Path -LiteralPath (Join-Path $previous 'src\server\releaseHandoff.ts')) -and
  ((Get-SvcState $WorkerService) -eq 'Running')
if ($workerHandsOff) {
  Write-Output 'WORKER=left running; it moves to the new release when it holds no job'
}
else {
  # Worker first so nothing is mid-job while the server goes, and started
  # after the server so it never races an absent API.
  & sc.exe stop $WorkerService | Out-Null
  if (-not (Wait-Svc $WorkerService 'Stopped')) { throw "$WorkerService would not stop" }
}
& sc.exe stop $ServerService | Out-Null
if (-not (Wait-Svc $ServerService 'Stopped')) { throw "$ServerService would not stop" }

Set-Current $target

# Only needed the first time; harmless afterwards, and it keeps the services
# pointed at the pointer rather than at a version.
& $Nssm set $ServerService AppDirectory $current | Out-Null
& $Nssm set $WorkerService AppDirectory $current | Out-Null

# --- 7 and 8. restart, then prove it is actually serving -------------------
$failure = $null
& sc.exe start $ServerService | Out-Null
if (-not (Wait-Svc $ServerService 'Running')) { $failure = "$ServerService would not start" }
if (-not $failure -and -not $workerHandsOff) {
  & sc.exe start $WorkerService | Out-Null
  if (-not (Wait-Svc $WorkerService 'Running')) { $failure = "$WorkerService would not start" }
}

if (-not $failure) {
  # Running is not the same as serving. Readiness is, and it is what the deep
  # storage probe reports through.
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $j = (Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 10).Content | ConvertFrom-Json
      if ($j.data.ready) { $ready = $true; Write-Output ("HEALTH=" + ($j.data.checks | ConvertTo-Json -Compress)); break }
    }
    catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { $failure = 'service started but never reported ready' }
}

# --- 9. roll back on failure ----------------------------------------------
if ($failure) {
  Write-Output "FAILED=$failure"

  # A worker left running goes back on its own: it sees `current` name its
  # release again and takes work as before, or, if it had already moved over,
  # moves back once it holds nothing.
  if (-not $workerHandsOff) { & sc.exe stop $WorkerService | Out-Null; Wait-Svc $WorkerService 'Stopped' | Out-Null }
  & sc.exe stop $ServerService | Out-Null; Wait-Svc $ServerService 'Stopped' | Out-Null

  # The junction goes back only if there was one. On a first activation there
  # was not, and leaving it pointing at the failed release is harmless once
  # the services no longer resolve through it.
  if ($previous) { Set-Current $previous }

  foreach ($svc in $ServerService, $WorkerService) {
    if ($previousAppDir[$svc]) { & $Nssm set $svc AppDirectory $previousAppDir[$svc] | Out-Null }
  }

  & sc.exe start $ServerService | Out-Null; $backUp = Wait-Svc $ServerService 'Running'
  if (-not $workerHandsOff) { & sc.exe start $WorkerService | Out-Null; Wait-Svc $WorkerService 'Running' | Out-Null }

  Write-Output ("ROLLED_BACK_TO=" + $previousAppDir[$ServerService])
  if (-not $backUp) { Write-Output 'ROLLBACK_INCOMPLETE: the previous version did not come back up either' }
  exit 1
}

Write-Phase 'switch+health'
Write-Output "ACTIVE=$Version"
Write-Output ("CURRENT=" + (Get-CurrentTarget))
Write-Output 'ACTIVATED'

# --- 10. prune what earlier deploys left behind ----------------------------
# After the activation has succeeded, never before: until then the previous
# release is the rollback. A failure here is reported and nothing more — the
# new release is already serving, and leftover space is not an outage.
#
# In the background: it took 20 seconds of every deployment, and nothing waits
# on it. A SYSTEM scheduled task rather than a child process, because a process
# started from an SSH session dies when the session closes. The next deployment
# waits for a prune still running (ship-release.ps1), so the two never overlap.
try {
  $prune = Join-Path $PSScriptRoot 'prune-releases.ps1'
  $log = Join-Path (Split-Path -Parent $AppRoot) 'logs\prune-releases.log'
  $arguments = '/c powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -AppRoot "{1}" > "{2}" 2>&1' -f $prune, $AppRoot, $log
  $task = 'SeyirlikPruneReleases'
  Register-ScheduledTask -TaskName $task -Force `
    -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arguments) `
    -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
    -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30)) | Out-Null
  Start-ScheduledTask -TaskName $task
  Write-Output "PRUNE=running in the background; see $log"
}
catch {
  Write-Output ("PRUNE_FAILED=" + $_.Exception.Message)
}
Write-Phase 'prune'
