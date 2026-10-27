<#
.SYNOPSIS
Stages a release on the helper laptop (MSI) and makes it current, without
touching the worker that is running.

.DESCRIPTION
Run by deploy/ship.sh over SSH, in two calls around a `git archive | tar`:

    stage-release.ps1 -Version <v> -Commit <sha> -Prepare   # make the folder
    (the Mac extracts the commit into it)
    stage-release.ps1 -Version <v> -Commit <sha>            # finish and switch

The laptop's worker is started from `C:\Seyirlik\app\current` by the Start
Seyirlik window. Switching that junction is the whole deployment: the worker
notices, finishes the job it holds, exits, and the window starts it again on
the new release (src/server/releaseHandoff.ts). Nothing here stops a process,
so nothing here can cost an encode.

Every new release gets a new folder, and nothing is deleted: a folder another
release's node_modules junction points into must outlive that release, and
clearing folders by hand is how a release once lost its dependencies.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $Version,

  [Parameter(Mandatory = $true)]
  [string] $Commit,

  [switch] $Prepare,

  [string] $AppRoot = 'C:\Seyirlik\app',
  [string] $ConfigDir = 'C:\Seyirlik\config',
  [string] $NodeDir = 'C:\Seyirlik\runtime\node'
)

$ErrorActionPreference = 'Stop'

$target = Join-Path $AppRoot $Version
$current = Join-Path $AppRoot 'current'

if ($Prepare) {
  if (Test-Path -LiteralPath $target) { throw "$target already exists; ship under a new version" }
  New-Item -ItemType Directory -Path $target | Out-Null
  Write-Output "PREPARED=$target"
  exit 0
}

foreach ($required in 'package-lock.json', 'src\server\mediaWorker.ts') {
  if (-not (Test-Path -LiteralPath (Join-Path $target $required))) {
    throw "$target has no $required; was the archive extracted into it?"
  }
}

# --- dependencies ----------------------------------------------------------
# Reused from a release that installed the same lock, through a junction to
# the folder that really holds them; installed afresh otherwise. The lock's
# hash is what decides, never the version, so a release whose lock changed
# can never run on modules installed for another.
$lockSha = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target 'package-lock.json')).Hash.ToLowerInvariant()
$linkedFrom = $null
foreach ($release in Get-ChildItem -LiteralPath $AppRoot -Directory | Where-Object { $_.Name -ne 'current' -and $_.Name -ne $Version } | Sort-Object Name -Descending) {
  $manifestPath = Join-Path $release.FullName 'RELEASE.json'
  $modules = Join-Path $release.FullName 'node_modules'
  if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $modules)) { continue }
  try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { continue }
  if ($manifest.dependencies.lockSha256 -ne $lockSha) { continue }
  $item = Get-Item -LiteralPath $modules -Force
  $real = if ($item.LinkType -eq 'Junction') { @($item.Target)[0] } else { $item.FullName }
  if (-not (Test-Path -LiteralPath $real)) { continue }
  cmd /c mklink /J "$target\node_modules" "$real" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not link node_modules to $real" }
  $linkedFrom = "$($release.Name) (junction to $real)"
  break
}
if (-not $linkedFrom) {
  Write-Output "DEPENDENCIES=installing; no release here has lock $($lockSha.Substring(0, 12))"
  Push-Location $target
  try {
    $env:Path = "$NodeDir;$env:Path"
    & (Join-Path $NodeDir 'npm.cmd') ci --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed; nothing has been switched' }
  }
  finally { Pop-Location }
  $linkedFrom = 'npm ci'
}
Write-Output "DEPENDENCIES=$linkedFrom"

$nodeVersion = (& (Join-Path $NodeDir 'node.exe') --version).Trim()
$release = [ordered]@{
  version      = $Version
  commit       = $Commit
  stagedAt     = (Get-Date).ToUniversalTime().ToString('o')
  stagedBy     = 'deploy/msi/stage-release.ps1'
  nodeVersion  = $nodeVersion
  dependencies = [ordered]@{ linkedFrom = $linkedFrom; lockSha256 = $lockSha }
}
[IO.File]::WriteAllText((Join-Path $target 'RELEASE.json'), ($release | ConvertTo-Json -Depth 4))

# A crash before the cache reaches the disk zero-fills files that were
# written but not flushed; the Windows server lost a staged release that way.
# Flushed before the check, so the check reads what the disk holds.
try { Storage\Write-VolumeCache -DriveLetter ($target.Substring(0, 1)) ; Write-Output 'FLUSHED=C' }
catch { Write-Output ("FLUSH_SKIPPED=" + $_.Exception.Message) }

# --- prove the worker would start -------------------------------------------
# With this laptop's own configuration, before the junction moves: once it
# has, the running worker leaves for whatever `current` names.
Push-Location $target
try {
  & (Join-Path $NodeDir 'node.exe') "--env-file=$ConfigDir\settings.env" "--env-file=$ConfigDir\secrets.env" --import tsx src/server/mediaWorker.ts --check
  if ($LASTEXITCODE -ne 0) { throw "the worker in $Version would not start; nothing has been switched" }
}
finally { Pop-Location }

# --- switch ------------------------------------------------------------------
$previous = $null
if (Test-Path -LiteralPath $current) {
  $previous = @((Get-Item -LiteralPath $current -Force).Target)[0]
  # Delete() on the link item removes the junction, never what it points at.
  (Get-Item -LiteralPath $current -Force).Delete()
}
New-Item -ItemType Junction -Path $current -Target $target | Out-Null
Write-Output "PREVIOUS=$previous"
Write-Output "SWITCHED=$Version"

if ($previous -and -not (Test-Path -LiteralPath (Join-Path $previous 'src\server\releaseHandoff.ts'))) {
  Write-Output 'WORKER=the running worker predates the hand-off; it moves to this release the next time it restarts'
}
else {
  Write-Output 'WORKER=moves to this release once it holds no job'
}
