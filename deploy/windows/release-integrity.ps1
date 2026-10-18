<#
.SYNOPSIS
The zero-fill check shared by stage-release.ps1 and activate-release.ps1.
Dot-source it; it defines a function and does nothing else.

.DESCRIPTION
On 2026-09-29 the host crashed about a minute after 2026.09.29-10 was staged
and activated, before Windows had written the copy out. NTFS had already
recorded the files' sizes, so on reboot nine of them existed at the right
length and held nothing but zeros. tsx's loader.mjs was one; the server died on
its first byte and NSSM left both services Paused.

A crash-damaged file keeps its length and loses its content, so the tell is a
non-empty file whose opening bytes are all zero. No text file starts that way,
and neither does anything node_modules loads natively (PE, ELF and wasm all
open with a signature). Reading only the first 64 bytes keeps a pass over a
~32k-file release to seconds rather than a full read of every byte.
#>

# Returns how many files it looked at and the full path of every damaged one,
# so a caller can report both a clean pass and a refusal the same way.
#
# -SkipTopLevel leaves out whole top-level directories, for content that is
# already known to be on disk and checked: staging hard-links an unchanged
# node_modules from an earlier release, and those links are that release's own
# files, flushed and checked when it was staged and never written since.
function Find-ZeroFilledFiles([string] $Root, [string[]] $SkipTopLevel = @(), [string[]] $OnlyRelative = $null) {
  $probe = New-Object byte[] 64
  $damaged = New-Object System.Collections.Generic.List[string]
  $checked = 0

  # Given a list, only those files: the ones a staging run actually wrote,
  # when the rest are hard links to a release already checked.
  $files = if ($null -ne $OnlyRelative) {
    foreach ($relative in $OnlyRelative) {
      Get-Item -LiteralPath (Join-Path $Root $relative) -Force
    }
  }
  else {
    foreach ($entry in Get-ChildItem -LiteralPath $Root -Force) {
      if ($entry.PSIsContainer) {
        if ($SkipTopLevel -contains $entry.Name) { continue }
        Get-ChildItem -LiteralPath $entry.FullName -Recurse -File -Force
      }
      else { $entry }
    }
  }

  foreach ($file in $files) {
    $checked++
    # Empty is a legitimate state for a file; zero-filled is not, and the two
    # are only distinguishable when there is something to read.
    if ($file.Length -eq 0) { continue }

    $want = [int][Math]::Min($probe.Length, $file.Length)
    $read = 0
    $stream = [IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite')
    try {
      while ($read -lt $want) {
        $n = $stream.Read($probe, $read, $want - $read)
        if ($n -le 0) { break }
        $read += $n
      }
    }
    finally { $stream.Dispose() }

    # A healthy file almost always fails this on its first byte, so the loop
    # costs one comparison per file rather than sixty-four.
    $allZero = $read -gt 0
    for ($i = 0; $i -lt $read; $i++) {
      if ($probe[$i] -ne 0) { $allZero = $false; break }
    }
    if ($allZero) { $damaged.Add($file.FullName) }
  }

  [pscustomobject]@{ Checked = $checked; Damaged = $damaged.ToArray() }
}
