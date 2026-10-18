<#
.SYNOPSIS
Writes an immutable release directory from a git checkout, without touching
whatever is currently serving.

.DESCRIPTION
Step 1 of the sequence in docs/deployment-model.md. Staging is the half of a
deployment that is allowed to fail freely: nothing here is visible to a running
service, so an abort leaves production exactly as it was.

The release contents come from two different places on purpose:

  tracked source   `git archive` of an exact commit, so a release cannot
                   contain a stray edit that was never committed. This is the
                   property the validation checkout does not have — it is a
                   working tree, and a working tree is editable by anyone who
                   can reach it.

  node_modules     copied from the source checkout rather than installed,
                   because an install would resolve versions at deployment
                   time and a release must be the thing that was tested.
                   When an earlier release was staged from the same
                   package-lock.json and Node, its node_modules is hard-linked
                   instead: the same files, already on disk and checked, so
                   the release costs seconds rather than a copy and a first
                   read of 33,000 new files (about 8 minutes on this host).

  dist             the built frontend, likewise copied rather than rebuilt.

The release is never edited after this script writes it. Rolling back is
therefore repointing a junction, not restoring files.
#>
[CmdletBinding()]
param(
  # The git checkout to cut the release from. Its HEAD is what gets released.
  [string] $SourceCheckout = 'C:\SeyirlikValidation\phase-0b-20260907-215500\candidate',

  # Where releases live. Its ACL is what makes the release immutable to the
  # services: they inherit ReadAndExecute here and nothing more.
  [string] $AppRoot = 'C:\ProgramData\Seyirlik\app',

  # Defaults to a dated, sequenced name. Explicit for a rehearsal.
  [string] $Version,

  # Consulted only to keep release numbers from being reused: a deployment
  # backup is named after its release, so it still spends that name.
  [string] $BackupRoot = 'C:\ProgramData\Seyirlik\backups',

  # The virtual accounts the services run as. They need to read a release and
  # must not be able to write one.
  [string[]] $ServiceAccounts = @('NT SERVICE\SeyirlikServer', 'NT SERVICE\SeyirlikWorker'),
  # Link `dist` from the active release instead of copying the checkout's,
  # rewriting only version.json's commit. For a commit that changes nothing
  # the frontend is built from (ship-release.ps1 decides), so it was not
  # rebuilt; the buildId stays, which is what open tabs compare.
  [switch] $ReuseDist
)

$ErrorActionPreference = 'Stop'

# Each phase reports its own time, so a slow deployment says where it was slow.
$phaseClock = [Diagnostics.Stopwatch]::StartNew()
function Write-Phase([string] $Name) {
  Write-Output ("PHASE={0}:{1:0.0}s" -f $Name, $phaseClock.Elapsed.TotalSeconds)
  $phaseClock.Restart()
}

if (-not (Test-Path -LiteralPath $SourceCheckout)) { throw "source checkout not found: $SourceCheckout" }

$releases = Join-Path $AppRoot 'releases'
New-Item -ItemType Directory -Force -Path $releases | Out-Null

<#
Phase 1 granted the service accounts access one directory at a time, with no
inheritance flags — `config` is readable, `logs` is writable, and each grant
stops at that folder. It is a good pattern and it means a new directory under
`C:\ProgramData\Seyirlik` starts with no service access at all: the first
release staged here was readable only by SYSTEM and Administrators, and the
services would have failed to start against it.

So the app root carries one inheritable read grant, and every release under it
inherits exactly that. Read and execute, never write: a release the running
service could modify would not be immutable in the sense that matters.
#>
$rootAcl = Get-Acl $AppRoot
$changed = $false
foreach ($account in $ServiceAccounts) {
  $existing = $rootAcl.Access | Where-Object {
    $_.IdentityReference.Value -eq $account -and
    $_.AccessControlType -eq 'Allow' -and
    $_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit
  }
  if (-not $existing) {
    $rootAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      $account,
      [Security.AccessControl.FileSystemRights]::ReadAndExecute,
      'ContainerInherit, ObjectInherit',
      'None',
      'Allow')))
    $changed = $true
  }
}
if ($changed) { Set-Acl -Path $AppRoot -AclObject $rootAcl; Write-Output "APPROOT_ACL=granted" }

# A release names the day it was cut and its order within that day, so two
# releases on one day cannot collide and the sequence reads chronologically.
if (-not $Version) {
  $day = Get-Date -Format 'yyyy.MM.dd'

  <#
  The sequence is the highest number ever used today plus one, not the first
  free slot. Pruning a release must not hand its name to a different one: the
  deployment backups are named after the release they were taken for, and two
  releases sharing a name make that record ambiguous exactly when somebody is
  reading it to decide what to roll back to.

  So the backups are consulted as well as the releases directory. A pruned
  release leaves its backup behind, and that is enough to keep its name spent.
  #>
  $used = @()
  foreach ($name in (Get-ChildItem -LiteralPath $releases -Directory -ErrorAction SilentlyContinue).Name) {
    if ($name -match "^$([regex]::Escape($day))-(\d+)$") { $used += [int]$Matches[1] }
  }
  if (Test-Path -LiteralPath $BackupRoot) {
    foreach ($name in (Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue).Name) {
      if ($name -match "^release-$([regex]::Escape($day))-(\d+)-") { $used += [int]$Matches[1] }
    }
  }
  $next = 1
  if ($used.Count -gt 0) { $next = (($used | Measure-Object -Maximum).Maximum + 1) }
  $Version = "$day-$next"
}

$target = Join-Path $releases $Version
if (Test-Path -LiteralPath $target) { throw "release already exists, refusing to overwrite: $target" }

<#
Which package-lock.json the checkout's node_modules was installed from. The
deploy wrapper (ship-release.ps1) writes this marker after every `npm ci`; a
checkout without it, or with a stale one, is copied as it always was, and the
release records no lock, so no later release links from it.
#>
$nodeVersion = (& node --version).Trim()
$lockSha = (Get-FileHash -LiteralPath (Join-Path $SourceCheckout 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$installedMarker = Join-Path $SourceCheckout 'node_modules\.seyirlik-lock.sha256'
$installedLock = if (Test-Path -LiteralPath $installedMarker) { (Get-Content -LiteralPath $installedMarker -Raw).Trim() } else { $null }
$dependencyLock = if ($installedLock -eq $lockSha) { $lockSha } else { $null }

# A release to link node_modules from: installed from this same lock with this
# same Node, and checked at its own staging (INTEGRITY.json exists only then).
$donor = $null
if ($dependencyLock) {
  $donor = Get-ChildItem -LiteralPath $releases -Directory | ForEach-Object {
    $manifestPath = Join-Path $_.FullName 'RELEASE.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $_.FullName 'INTEGRITY.json'))) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $_.FullName 'node_modules'))) { return }
    try { $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { return }
    if ($m.dependencies -and $m.dependencies.lockSha256 -eq $dependencyLock -and $m.nodeVersion -eq $nodeVersion) {
      [pscustomobject]@{ Path = $_.FullName; Name = $_.Name; StagedAt = [string]$m.stagedAt }
    }
  } | Sort-Object StagedAt -Descending | Select-Object -First 1
}

# Hard links through the Win32 call, with the loop compiled: New-Item -ItemType
# HardLink takes about a second per hundred files, and even a PowerShell loop
# over CreateHardLink spent 14 seconds on 33,000 of them.
if (-not ('Seyirlik.ReleaseLinks' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
namespace Seyirlik {
  public static class ReleaseLinks {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateHardLink(string lpFileName, string lpExistingFileName, IntPtr lpSecurityAttributes);

    static void Link(string from, string to) {
      if (!CreateHardLink(to, from, IntPtr.Zero)) {
        throw new IOException(String.Format("hard link failed for {0} (Win32 error {1})", from, Marshal.GetLastWin32Error()));
      }
    }

    // Linking is metadata work NTFS does in parallel: node_modules' 33,600
    // files took 14 s one at a time and 6 s on eight threads (16 was slower).
    static void LinkAll(string[] froms, string[] tos) {
      try {
        Parallel.For(0, froms.Length, new ParallelOptions { MaxDegreeOfParallelism = 8 }, i => Link(froms[i], tos[i]));
      }
      catch (AggregateException failure) {
        throw failure.InnerExceptions[0];
      }
    }

    /// Every file under `from`, linked at the same relative path under `to`.
    public static int LinkTree(string from, string to) {
      int fromLength = from.Length;
      Directory.CreateDirectory(to);
      foreach (var dir in Directory.EnumerateDirectories(from, "*", SearchOption.AllDirectories)) {
        Directory.CreateDirectory(to + dir.Substring(fromLength));
      }
      var froms = Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories).ToArray();
      LinkAll(froms, froms.Select(file => to + file.Substring(fromLength)).ToArray());
      return froms.Length;
    }

    /// These relative paths (forward slashes), linked from `fromRoot` into `toRoot`.
    public static int LinkFiles(string fromRoot, string toRoot, string[] relativePaths) {
      var natives = relativePaths.Select(relative => relative.Replace('/', Path.DirectorySeparatorChar)).ToArray();
      var tos = natives.Select(native => Path.Combine(toRoot, native)).ToArray();
      foreach (var dir in tos.Select(Path.GetDirectoryName).Distinct()) {
        Directory.CreateDirectory(dir);
      }
      LinkAll(natives.Select(native => Path.Combine(fromRoot, native)).ToArray(), tos);
      return natives.Length;
    }
  }
}
'@
}
function Copy-TreeAsHardLinks([string] $From, [string] $To) {
  return [Seyirlik.ReleaseLinks]::LinkTree($From, $To)
}

<#
The release being replaced, when it can lend this one its unchanged files.

Most of a release is the previous release: a deployment changes a handful of
source files. Writing all 1,600 again meant Defender read every one of them on
the first open, which was most of the 20 seconds verification took. A file
whose path git says did not change since the active release's commit is that
release's file, already on disk and checked when it was staged, so it is
linked instead; only changed files are written. Same rules as node_modules:
the donor must have been verified (INTEGRITY.json) and its commit must be
known to this checkout, or everything is extracted as it always was.
#>
$sourceDonor = $null
$currentLink = Join-Path $AppRoot 'current'
if (Test-Path -LiteralPath $currentLink) {
  $activePath = (Get-Item -LiteralPath $currentLink).Target | Select-Object -First 1
  if ($activePath -and (Test-Path -LiteralPath (Join-Path $activePath 'INTEGRITY.json'))) {
    try {
      $activeManifest = Get-Content -LiteralPath (Join-Path $activePath 'RELEASE.json') -Raw | ConvertFrom-Json
      & git -C $SourceCheckout cat-file -e "$($activeManifest.commit)^{commit}" 2>$null
      if ($LASTEXITCODE -eq 0) {
        $sourceDonor = [pscustomobject]@{ Path = $activePath; Commit = [string]$activeManifest.commit; Name = (Split-Path -Leaf $activePath) }
      }
    }
    catch { $sourceDonor = $null }
  }
}

Push-Location $SourceCheckout
try {
  $commit = (& git rev-parse HEAD).Trim()
  $tree = (& git show -s --format=%T HEAD).Trim()
  # A release cut from a dirty tree would not be reproducible from its commit,
  # which defeats the point of recording one.
  $dirty = (& git status --porcelain) -join "`n"
  if ($dirty) { throw "source checkout has uncommitted changes; refusing to cut a release that no commit describes:`n$dirty" }

  New-Item -ItemType Directory -Force -Path $target | Out-Null

  # Paths this release must contain, and which of them changed since the
  # donor. `-z` keeps unusual characters in names intact.
  $allPaths = @((& git -c core.quotepath=off ls-tree -r --name-only -z HEAD) -split "`0" | Where-Object { $_ })
  $writePaths = $allPaths
  $linkedSourceFiles = 0
  # PowerShell decodes git's output with the console code page, so a name
  # outside printable ASCII could come back altered; extract everything then.
  if ($sourceDonor -and @($allPaths | Where-Object { $_ -match '[^\x20-\x7E]' }).Count -gt 0) {
    Write-Output 'SOURCE_LINK_SKIPPED=a path is not plain ASCII; extracting everything'
    $sourceDonor = $null
  }
  if ($sourceDonor) {
    $changedPaths = @((& git -c core.quotepath=off diff --name-only -z --no-renames $sourceDonor.Commit HEAD) -split "`0" | Where-Object { $_ })
    $changedSet = [Collections.Generic.HashSet[string]]::new([string[]]$changedPaths, [StringComparer]::Ordinal)
    $linkPaths = New-Object System.Collections.Generic.List[string]
    $extract = New-Object System.Collections.Generic.List[string]
    foreach ($relative in $allPaths) {
      $inDonor = [IO.File]::Exists((Join-Path $sourceDonor.Path $relative))
      if (-not $changedSet.Contains($relative) -and $inDonor) { $linkPaths.Add($relative) } else { $extract.Add($relative) }
    }
    try {
      $linkedSourceFiles = [Seyirlik.ReleaseLinks]::LinkFiles($sourceDonor.Path, $target, $linkPaths.ToArray())
      $writePaths = $extract.ToArray()
      Write-Output ("LINKED_SOURCE={0} files from {1}; writing {2}" -f $linkedSourceFiles, $sourceDonor.Name, $writePaths.Count)
    }
    catch {
      # Removing the half-made tree removes links, never the donor's files.
      Write-Output ("SOURCE_LINK_FAILED=" + $_.Exception.Message + "; extracting everything")
      Remove-Item -LiteralPath $target -Recurse -Force
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      $sourceDonor = $null
      $linkedSourceFiles = 0
      $writePaths = $allPaths
    }
  }

  # git archive writes only tracked files at that commit. Via a tar file
  # rather than a pipe, because PowerShell's pipeline is text and would
  # corrupt the stream. Paths go in batches so a large change cannot exceed
  # the command line.
  if ($writePaths.Count -gt 0) {
    $tar = Join-Path ([IO.Path]::GetTempPath()) "seyirlik-release-$Version.tar"
    $batches = if ($sourceDonor) { [Math]::Ceiling($writePaths.Count / 200) } else { 1 }
    for ($b = 0; $b -lt $batches; $b++) {
      $paths = if ($sourceDonor) { @($writePaths | Select-Object -Skip ($b * 200) -First 200) } else { @() }
      & git archive --format=tar -o $tar HEAD -- @paths
      if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
      & tar.exe -xf $tar -C $target
      if ($LASTEXITCODE -ne 0) { throw 'extracting the release archive failed' }
      Remove-Item -LiteralPath $tar -Force
    }
  }
}
finally { Pop-Location }

Write-Phase 'source'

# /MIR would be wrong here: the destination is new, and mirroring invites a
# delete against the wrong path if it ever is not.
$linkedFrom = $null
$linkedFiles = 0
$distLinked = $false
if ($ReuseDist) {
  if (-not $sourceDonor -or -not (Test-Path -LiteralPath (Join-Path $sourceDonor.Path 'dist\version.json'))) {
    throw 'ReuseDist needs a verified active release with a dist; build instead'
  }
  $distFiles = [Seyirlik.ReleaseLinks]::LinkTree((Join-Path $sourceDonor.Path 'dist'), (Join-Path $target 'dist'))
  # version.json is replaced, not edited: it is a link to the donor's file.
  # Only the commit changes, as text: the file is UTF-8 with a "·" in its
  # version, which Get-Content would read as ANSI and write back mangled.
  $versionPath = Join-Path $target 'dist\version.json'
  $versionText = [IO.File]::ReadAllText($versionPath, [Text.Encoding]::UTF8)
  $newCommit = (& git -C $SourceCheckout rev-parse HEAD).Trim()
  $rewritten = [regex]::Replace($versionText, '("commit"\s*:\s*")[0-9a-f]{40}(")', "`${1}$newCommit`${2}")
  if ($rewritten -eq $versionText -and $versionText -notmatch $newCommit) { throw 'version.json has no commit to rewrite; build instead' }
  Remove-Item -LiteralPath $versionPath -Force
  [IO.File]::WriteAllText($versionPath, $rewritten, (New-Object Text.UTF8Encoding $false))
  $distLinked = $true
  Write-Output ("LINKED_DIST={0} files from {1}; frontend unchanged" -f $distFiles, $sourceDonor.Name)
}
foreach ($dir in 'node_modules', 'dist') {
  if ($dir -eq 'dist' -and $distLinked) { continue }
  $from = Join-Path $SourceCheckout $dir
  if (-not (Test-Path -LiteralPath $from)) { throw "source checkout has no $dir; build or install first" }
  $to = Join-Path $target $dir
  if ($dir -eq 'node_modules' -and $donor) {
    try {
      $linkedFiles = Copy-TreeAsHardLinks (Join-Path $donor.Path 'node_modules') $to
      $linkedFrom = $donor.Name
      Write-Output ("LINKED_DEPENDENCIES={0} files from {1}" -f $linkedFiles, $donor.Name)
      continue
    }
    catch {
      # Removing the half-made tree removes links, never the donor's files.
      Write-Output ("LINK_FAILED=" + $_.Exception.Message + "; copying instead")
      if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
      $linkedFiles = 0
    }
  }
  & robocopy $from $to /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  # robocopy exits 0-7 for success; 8 and above is a genuine failure.
  if ($LASTEXITCODE -ge 8) { throw "copying $dir failed (robocopy $LASTEXITCODE)" }
}
Write-Phase 'dependencies+dist'

# A release the services cannot read is a failed deployment discovered at
# restart, when the previous version has already been stopped. Discover it
# here instead, while nothing is at stake.
$releaseAcl = (Get-Acl $target).Access
foreach ($account in $ServiceAccounts) {
  $canRead = $releaseAcl | Where-Object {
    $_.IdentityReference.Value -eq $account -and
    $_.AccessControlType -eq 'Allow' -and
    ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute)
  }
  if (-not $canRead) { throw "staged release is not readable by $account; the services would not start against it" }
}

# Evidence, not intent: what this release actually is, recorded beside it so
# an operator can tell two releases apart without trusting the directory name.
$manifest = [ordered]@{
  version        = $Version
  commit         = $commit
  tree           = $tree
  sourceCheckout = $SourceCheckout
  stagedAt       = (Get-Date).ToUniversalTime().ToString('o')
  stagedBy       = "$env:USERDOMAIN\$env:USERNAME"
  nodeVersion    = $nodeVersion
  # The lock node_modules was installed from (null when that is not known),
  # and the release it was hard-linked from, if any.
  dependencies   = [ordered]@{ lockSha256 = $dependencyLock; linkedFrom = $linkedFrom }
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'RELEASE.json') -Encoding UTF8

<#
A release that exists only in the write cache is not staged. 2026.09.29-10 was
activated a minute after this script finished and the host crashed before
Windows wrote it out: nine files came back zero-filled and the services went
down with them. So the volume is flushed before staging reports success, and
activation can follow as soon as it likes.

Last, so RELEASE.json is in the flush too.
#>
$drive = [IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $target).ProviderPath)
if ($drive -notmatch '^([A-Za-z]):\\$') { throw "cannot flush $target; it is not on a lettered volume" }
Storage\Write-VolumeCache -DriveLetter $Matches[1]
Write-Output ("FLUSHED=" + $Matches[1])
Write-Phase 'flush'

# Reads come from the cache just flushed, so this cannot see a write that never
# reached the disk — activation's own check is the one that catches a later
# crash. What it does catch is damage carried in from the source checkout,
# which after a crash is as likely to have been hit as the release.
#
# A hard-linked node_modules is not read: those are the donor release's files,
# checked when it was staged and never written since, and a first read of
# 33,000 new paths costs this host about seven minutes.
. (Join-Path $PSScriptRoot 'release-integrity.ps1')
$skip = if ($linkedFrom) { @('node_modules') } else { @() }
# Linked source and dist are the donor's checked files, like node_modules.
if ($distLinked) { $skip += 'dist' }
# With a source donor only what was written is new: the changed source, plus
# a dist copied from the checkout when it was not linked.
$onlyPaths = $null
if ($sourceDonor) {
  $onlyPaths = New-Object System.Collections.Generic.List[string]
  foreach ($relative in $writePaths) { $onlyPaths.Add($relative) }
  if (-not $distLinked) {
    $distRoot = Join-Path $target 'dist'
    foreach ($file in [IO.Directory]::EnumerateFiles($distRoot, '*', 'AllDirectories')) {
      $onlyPaths.Add(('dist' + $file.Substring($distRoot.Length)).Replace('\', '/'))
    }
  }
  $onlyPaths = $onlyPaths.ToArray()
}
$integrity = Find-ZeroFilledFiles $target -SkipTopLevel $skip -OnlyRelative $onlyPaths
if ($integrity.Damaged.Count -gt 0) {
  throw ("staged release has $($integrity.Damaged.Count) zero-filled file(s); do not activate it:`n" + ($integrity.Damaged -join "`n"))
}
Write-Output ("VERIFIED_FILES=" + $integrity.Checked)
Write-Phase 'verify'

<#
The record activation trusts instead of reading every file again: which boot
this release was flushed and checked in. Zero-fill needs a crash, and a crash
is a new boot, so while the boot is the same nothing here can have changed.
It is written after the flush on purpose: if a crash takes it, the release
simply has no record, and activation reads every file, as it always did.
#>
$bootTicks = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks
[ordered]@{
  checkedFiles = $integrity.Checked
  linkedFiles  = $linkedFiles
  linkedSourceFiles = $linkedSourceFiles
  sourceLinkedFrom  = if ($sourceDonor) { $sourceDonor.Name } else { $null }
  linkedFrom   = $linkedFrom
  bootTicks    = $bootTicks
  verifiedAt   = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'INTEGRITY.json') -Encoding UTF8

Write-Output "STAGED=$Version"
Write-Output "PATH=$target"
Write-Output "COMMIT=$commit"
Write-Output "TREE=$tree"
