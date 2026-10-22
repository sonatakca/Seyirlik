<#
.SYNOPSIS
Builds, stages and activates one commit on this host, in one call.

.DESCRIPTION
The Windows half of deploy/ship.sh, which copies this script into scratch and
runs it over SSH. Before it existed every step was its own remote command,
and a deployment took twenty minutes of which the work was a fraction.

  1. refuse if another deployment (or a prune) is running on this host;
  2. fetch the commit from a git bundle into the release-build clone;
  3. `npm ci` only when package-lock.json differs from what the clone's
     node_modules was installed from (a marker this script writes), which
     is also what lets staging hard-link node_modules from a release with
     the same lock;
  4. build the frontend with vite alone: the type check runs on the Mac
     before anything is shipped, and repeating it here cost a minute;
  5. stage-release.ps1, then activate-release.ps1 (which migrates).

Every phase prints PHASE=<name>:<seconds>.
#>
[CmdletBinding()]
param(
  # A git bundle holding -Ref, already copied to this host.
  [Parameter(Mandatory)] [string] $Bundle,
  [Parameter(Mandatory)] [string] $Ref,
  # The release-build clone. Its name is historical; check its HEAD.
  [string] $Clone = 'C:\ProgramData\Seyirlik\scratch\ui-release-42e325f',
  # Stage without activating, for a rehearsal.
  [switch] $StageOnly,
  # Build the frontend even when nothing it is built from changed.
  [switch] $ForceBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$total = [Diagnostics.Stopwatch]::StartNew()
$phaseClock = [Diagnostics.Stopwatch]::StartNew()
function Write-Phase([string] $Name) {
  Write-Output ("PHASE={0}:{1:0.0}s" -f $Name, $phaseClock.Elapsed.TotalSeconds)
  $phaseClock.Restart()
}

# git and npm write progress to stderr, which 'Stop' would turn into a failure;
# run them through cmd and judge them by exit code alone.
function Invoke-Native([string] $CommandLine, [string] $What) {
  $output = cmd /c "$CommandLine 2>&1"
  if ($LASTEXITCODE -ne 0) {
    $output | Select-Object -Last 20 | ForEach-Object { Write-Output "  $_" }
    throw "$What failed (exit $LASTEXITCODE)"
  }
}

# Two deployments share this clone and pick the same release number, and the
# second one's cleanup can delete the first one's half-written release.
# This script's own process, and the shell OpenSSH started it from, both carry
# its name on their command lines.
$self = @($PID, (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)
function Get-Busy {
  Get-CimInstance Win32_Process | Where-Object {
    $self -notcontains $_.ProcessId -and
    $_.CommandLine -match 'ship-release|stage-release|activate-release|prune-releases|Robocopy'
  }
}
# The previous deployment's prune runs in the background after it activates.
# That one is waited for rather than refused: it is not another deployment,
# and it finishes in seconds.
$busy = Get-Busy
for ($i = 0; $i -lt 60 -and $busy -and -not ($busy | Where-Object { $_.CommandLine -notmatch 'prune-releases' }); $i++) {
  Start-Sleep -Seconds 2
  $busy = Get-Busy
}
if ($busy) {
  $busy | ForEach-Object { Write-Output ("BUSY={0} {1}" -f $_.ProcessId, $_.CommandLine) }
  throw 'another deployment is running on this host; nothing was changed'
}

Invoke-Native "git -C `"$Clone`" config core.autocrlf false" 'setting core.autocrlf'
Invoke-Native "git -C `"$Clone`" fetch -q `"$Bundle`" `"$Ref`"" 'fetching the bundle'
Invoke-Native "git -C `"$Clone`" checkout -q --detach FETCH_HEAD" 'checking out the commit'
$commit = (& git -C $Clone rev-parse HEAD).Trim()
Write-Output "COMMIT=$commit"
Write-Phase 'fetch'

$lockSha = (Get-FileHash -LiteralPath (Join-Path $Clone 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$marker = Join-Path $Clone 'node_modules\.seyirlik-lock.sha256'
$installed = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { $null }
if ($installed -ne $lockSha) {
  Push-Location $Clone
  try { Invoke-Native 'npm ci --no-audit --no-fund' 'npm ci' }
  finally { Pop-Location }
  # No BOM and no newline: staging compares this to a hash string.
  [IO.File]::WriteAllText($marker, $lockSha)
  Write-Output 'DEPENDENCIES=installed'
}
else {
  Write-Output 'DEPENDENCIES=unchanged'
}
Write-Phase 'dependencies'

<#
Whether this commit changes anything the frontend is built from, against the
release that is serving now. When it does not, the build is skipped and the
active release's dist is linked into the new one (stage-release -ReuseDist),
with only version.json's commit rewritten. The buildId is left alone on
purpose: it is what open tabs compare, and the bundle they run is unchanged.

Conservative: anything under src/ outside src/server counts, because src/lib
is shared with the server, as do the build's own inputs. Tests never do.
#>
$reuseDist = $false
if (-not $ForceBuild) {
  $activeRelease = (Get-Item -LiteralPath 'C:\ProgramData\Seyirlik\app\current' -ErrorAction SilentlyContinue).Target | Select-Object -First 1
  if ($activeRelease -and (Test-Path -LiteralPath (Join-Path $activeRelease 'dist\version.json'))) {
    $activeCommit = [string](Get-Content -LiteralPath (Join-Path $activeRelease 'RELEASE.json') -Raw | ConvertFrom-Json).commit
    & git -C $Clone cat-file -e "$activeCommit^{commit}" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $changed = @(& git -C $Clone diff --name-only $activeCommit HEAD)
      $frontend = @($changed | Where-Object {
          ($_ -match '^src/' -and $_ -notmatch '^src/server/' -and $_ -notmatch '\.(test|integration\.test|browser\.test)\.(ts|tsx)$') -or
          $_ -match '^(index\.html|public/|vite\.config\.ts|tailwind\.config\.ts|postcss\.config\.js|package\.json|package-lock\.json|tsconfig\.json)'
        })
      if ($frontend.Count -eq 0) { $reuseDist = $true }
    }
  }
}

if ($reuseDist) {
  Write-Output 'FRONTEND=unchanged; reusing the active release''s dist'
}
else {
  Push-Location $Clone
  try {
    # Same-origin build: the API is this host, so no base URL is baked in.
    $env:VITE_OWN_API_BASE_URL = $null
    Invoke-Native 'npx vite build' 'vite build'
  }
  finally { Pop-Location }
}
Write-Phase 'build'

$stageScript = Join-Path $Clone 'deploy\windows\stage-release.ps1'
$stageArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $stageScript, '-SourceCheckout', $Clone)
if ($reuseDist) { $stageArgs += '-ReuseDist' }
$stageOutput = & powershell.exe @stageArgs 2>&1
$stageExit = $LASTEXITCODE
$stageOutput | ForEach-Object { Write-Output "  stage: $_" }
if ($stageExit -ne 0) { throw "staging failed (exit $stageExit); nothing was activated" }
$version = ($stageOutput | Where-Object { "$_" -match '^STAGED=(.+)$' } | ForEach-Object { $Matches[1] } | Select-Object -Last 1)
if (-not $version) { throw 'staging reported no version; nothing was activated' }
Write-Output "STAGED=$version"
Write-Phase 'stage'

if ($StageOnly) {
  Write-Output ("TOTAL={0:0.0}s" -f $total.Elapsed.TotalSeconds)
  return
}

$activateScript = Join-Path $Clone 'deploy\windows\activate-release.ps1'
$activateOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $activateScript -Version $version 2>&1
$activateExit = $LASTEXITCODE
$activateOutput | ForEach-Object { Write-Output "  activate: $_" }
if ($activateExit -ne 0) { throw "activation failed (exit $activateExit); see the lines above for what was rolled back" }
Write-Phase 'activate'

Write-Output "ACTIVATED=$version"
Write-Output ("TOTAL={0:0.0}s" -f $total.Elapsed.TotalSeconds)
