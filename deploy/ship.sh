#!/usr/bin/env bash
# Ships one commit to every production host, and says how long each took.
#
#   deploy/ship.sh [<commit>]        default: HEAD
#
# Seyirlik is served from three places, seven hostnames:
#   playback  the Windows host. A git bundle and deploy/windows/ship-release.ps1
#             go over SSH; that script builds, stages and activates there.
#   www       Vercel (www, apex, and the three sonatakca.com names): a
#             fast-forward push of main.
#   origin    this Mac: dist/ in the main checkout, which the Mac's server reads
#             on every request, built from a clean `git archive` so nobody's
#             uncommitted work goes out with it.
#
# And the helper laptop (MSI), which runs the heavy worker and serves nothing:
# once Windows has activated (and so migrated), the commit is staged there in
# a new folder and its `current` junction is switched. Its worker moves over by
# itself after the job it holds, so this never waits for an encode and never
# stops one; short jobs move at once, through a bridge (releaseBridge.ts). A
# laptop that is switched off is skipped and caught up by the next ship.
#
# When the commits touch the server, its migrations or the deploy scripts,
# Windows goes first and the front ends wait for it (a new front end may need
# the new API). Otherwise all three run at once.
set -euo pipefail

HOST="${SEYIRLIK_WINDOWS_HOST:-sonat@100.71.12.79}"
SCRATCH='C:\ProgramData\Seyirlik\scratch'
MSI_HOST="${SEYIRLIK_MSI_HOST:-sonat@100.112.168.11}"
MSI_APP='C:\Seyirlik\app'
MSI_TMP='C:\Seyirlik\tmp'
HOSTS=(www.seyirlik.org seyirlik.org origin.seyirlik.org playback.seyirlik.org
  www.seyirlik.sonatakca.com seyirlik.sonatakca.com frontend.sonatakca.com)

repo=$(git rev-parse --show-toplevel)
main_checkout=$(dirname "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)")
sha=$(git -C "$repo" rev-parse --verify "${1:-HEAD}^{commit}")
short=${sha:0:7}
tmp="${TMPDIR:-/tmp}"
lock="$tmp/seyirlik-ship.lock"
work=$(mktemp -d "$tmp/seyirlik-ship.XXXXXX")
started=$(date +%s)

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "STOPPED: $*"; exit 1; }
since() { echo $(($(date +%s) - $1)); }
live_commit() {
  curl -fsSL --max-time 10 "https://$1/version.json?probe=$RANDOM" 2>/dev/null |
    sed -nE 's/.*"commit": *"([0-9a-f]{40})".*/\1/p'
}

mkdir "$lock" 2>/dev/null || die "another ship is running from this Mac ($lock); delete it if it is stale"
cleanup() {
  rm -rf "$lock" "$work"
  git -C "$repo" branch -D "ship/$short" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "shipping $short: $(git -C "$repo" log -1 --format=%s "$sha")"
git -C "$repo" fetch -q origin
git -C "$repo" merge-base --is-ancestor origin/main "$sha" ||
  die "$short is not a fast-forward of origin/main; rebase it first"

# origin builds with the main checkout's node_modules, so they must match.
if ! git -C "$repo" show "$sha:package-lock.json" | cmp -s - "$main_checkout/package-lock.json"; then
  die "package-lock.json differs from the main checkout's; run npm ci there first"
fi

live=$(live_commit playback.seyirlik.org)
[ -n "$live" ] || die "could not read the Windows host's live commit"
git -C "$repo" cat-file -e "$live^{commit}" 2>/dev/null || die "the live commit ${live:0:7} is not in this repository"
base=$(git -C "$repo" merge-base "$live" "$sha")

sequential=0
if git -C "$repo" diff --name-only "$live" "$sha" -- src/server scripts deploy/windows package.json package-lock.json | grep -q .; then
  sequential=1
fi
# Whether the commits touch anything the frontend is built from. The same rule
# ship-release.ps1 uses to skip the Windows build: src/ outside src/server
# (src/lib is shared), the build's own inputs; never tests.
frontend=0
if git -C "$repo" diff --name-only "$live" "$sha" |
  grep -E '^src/|^(index\.html|public/|vite\.config\.ts|tailwind\.config\.ts|postcss\.config\.js|package\.json|package-lock\.json|tsconfig\.json)' |
  grep -vE '^src/server/|\.(test|integration\.test|browser\.test)\.(ts|tsx)$' | grep -q .; then
  frontend=1
fi

ship_windows() {
  local t; t=$(date +%s)
  if [ "$live" = "$sha" ]; then
    log "windows: already live"
    echo 0 >"$work/windows.time"
    return 0
  fi
  git -C "$repo" branch -f "ship/$short" "$sha" >/dev/null
  git -C "$repo" bundle create "$work/ship.bundle" "^$base" "ship/$short" >/dev/null 2>&1
  git -C "$repo" show "$sha:deploy/windows/ship-release.ps1" >"$work/ship-release.ps1"
  ssh -n -o BatchMode=yes "$HOST" "cmd /c if not exist $SCRATCH\\ops mkdir $SCRATCH\\ops" >/dev/null 2>&1
  scp -q -o BatchMode=yes "$work/ship.bundle" "$HOST:${SCRATCH//\\//}/ship-$short.bundle"
  scp -q -o BatchMode=yes "$work/ship-release.ps1" "$HOST:${SCRATCH//\\//}/ops/ship-release.ps1"
  # The remote exit status goes through a file: it is the only part of the
  # pipeline that says whether the release was activated.
  {
    ssh -n -o BatchMode=yes "$HOST" \
      "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $SCRATCH\\ops\\ship-release.ps1 -Bundle $SCRATCH\\ship-$short.bundle -Ref ship/$short" 2>&1
    echo $? >"$work/windows.exit"
  } | { grep --line-buffered -vE 'post-quantum|store now, decrypt later|openssh.com/pq|^[[:space:]]*$' || true; } |
    sed -l 's/^/  windows: /' | tee -a "$work/windows.out"
  since "$t" >"$work/windows.time"
  [ "$(cat "$work/windows.exit" 2>/dev/null)" = 0 ]
}

ship_www() {
  local t; t=$(date +%s)
  git -C "$repo" push -q origin "$sha:refs/heads/main"
  log "www: pushed main, waiting for Vercel"
  # Only version.json: an asset fetched before Vercel is ready caches a 404
  # at Cloudflare for a year.
  local deadline=$(($(date +%s) + 900))
  until [ "$(live_commit www.seyirlik.org)" = "$sha" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || { since "$t" >"$work/www.time"; return 1; }
    sleep 5
  done
  since "$t" >"$work/www.time"
  log "www: live"
}

ship_origin() {
  local t; t=$(date +%s)
  mkdir "$work/origin"
  git -C "$repo" archive "$sha" | tar -x -C "$work/origin"
  ln -s "$main_checkout/node_modules" "$work/origin/node_modules"
  (cd "$work/origin" && SEYIRLIK_BUILD_COMMIT="$sha" npx vite build \
    --outDir "$main_checkout/dist" --emptyOutDir >"$work/origin.log" 2>&1) ||
    { tail -20 "$work/origin.log"; since "$t" >"$work/origin.time"; return 1; }
  since "$t" >"$work/origin.time"
  log "origin: built"
}

ship_msi() {
  local t; t=$(date +%s)
  if ! ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$MSI_HOST" "exit" >/dev/null 2>&1; then
    log "msi: not reachable (switched off?); the next ship while it is on will stage it"
    return 0
  fi
  local msi_commit
  msi_commit=$(ssh -n -o BatchMode=yes "$MSI_HOST" "type $MSI_APP\\current\\RELEASE.json" 2>/dev/null |
    sed -nE 's/.*"commit": *"([0-9a-f]{40})".*/\1/p')
  if [ "$msi_commit" = "$sha" ]; then
    log "msi: already current"
    return 0
  fi
  # Staging costs the worker a few seconds between jobs and nothing else, so
  # only what the worker cannot possibly load is let off: components, styles
  # and tests. Everything else in src/ might be in its import graph.
  # Captured rather than piped into `grep -q`: under pipefail an early exit
  # there fails the pipeline and would read as "nothing changed".
  if [ -n "$msi_commit" ] && git -C "$repo" cat-file -e "$msi_commit^{commit}" 2>/dev/null; then
    local changed
    changed=$(git -C "$repo" diff --name-only "$msi_commit" "$sha" |
      grep -E '^(src/|scripts/|package\.json$|package-lock\.json$)' |
      grep -vE '^src/components/|\.css$|\.(test|integration\.test|browser\.test)\.(ts|tsx)$' || true)
    if [ -z "$changed" ]; then
      log "msi: nothing the worker runs changed since ${msi_commit:0:7}"
      return 0
    fi
  fi
  # Named like the Windows release it goes with, when there is one.
  local version
  version=$(sed -nE 's/^  windows: STAGED=(.+)$/\1/p' "$work/windows.out" 2>/dev/null | tail -1)
  [ -n "$version" ] || version="$(date +%Y.%m.%d)-$short"
  local script="$MSI_TMP\\stage-release.ps1"
  git -C "$repo" show "$sha:deploy/msi/stage-release.ps1" >"$work/stage-msi.ps1"
  scp -q -o BatchMode=yes "$work/stage-msi.ps1" "$MSI_HOST:${MSI_TMP//\\//}/stage-release.ps1"
  local ps="powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Version $version -Commit $sha"
  {
    ssh -n -o BatchMode=yes "$MSI_HOST" "$ps -Prepare" 2>&1 &&
      git -C "$repo" archive "$sha" | ssh -o BatchMode=yes "$MSI_HOST" "tar -xf - -C ${MSI_APP//\\//}/$version" 2>&1 &&
      ssh -n -o BatchMode=yes "$MSI_HOST" "$ps" 2>&1
    echo $? >"$work/msi.exit"
  } | { grep --line-buffered -vE 'post-quantum|store now, decrypt later|openssh.com/pq|^[[:space:]]*$' || true; } |
    sed -l 's/^/  msi: /'
  since "$t" >"$work/msi.time"
  [ "$(cat "$work/msi.exit" 2>/dev/null)" = 0 ]
}

failed=""
check_hosts=("${HOSTS[@]}")
if [ "$sequential" = 1 ] && [ "$frontend" = 0 ]; then
  # Nothing the browser runs changed, so the front ends have nothing to
  # deploy. main is still pushed, so it stays what production runs; Vercel
  # rebuilds the same bundle on its own time and nobody waits for it.
  log "server only: Windows; the front ends are unchanged"
  check_hosts=(playback.seyirlik.org)
  ship_windows || die "Windows did not activate"
  git -C "$repo" push -q origin "$sha:refs/heads/main"
  log "www: pushed main (frontend unchanged, not waited for)"
elif [ "$sequential" = 1 ]; then
  # Both changed. The front ends must not go live ahead of the API they call,
  # but they need not wait for the restart either: they start once Windows has
  # staged (the release exists and is verified), and Vercel's build overlaps
  # activation. If activation then fails and rolls back, www is ahead of the
  # server until this is shipped again, and the failure says so.
  log "server and frontend changed: front ends start once Windows has staged"
  : >"$work/windows.out"
  ship_windows & windows_pid=$!
  until grep -q '^  windows: STAGED=' "$work/windows.out" 2>/dev/null || ! kill -0 "$windows_pid" 2>/dev/null; do
    sleep 1
  done
  if ! grep -q '^  windows: STAGED=' "$work/windows.out"; then
    wait "$windows_pid"
    die "Windows did not stage; www and origin were left as they were"
  fi
  ship_www & www_pid=$!
  ship_origin & origin_pid=$!
  wait "$windows_pid" || failed="$failed windows(www-is-ahead-of-the-server)"
  wait "$www_pid" || failed="$failed www"
  wait "$origin_pid" || failed="$failed origin"
else
  log "front end only: all three at once"
  ship_windows & windows_pid=$!
  ship_www & www_pid=$!
  ship_origin & origin_pid=$!
  wait "$windows_pid" || failed="$failed windows"
  wait "$www_pid" || failed="$failed www"
  wait "$origin_pid" || failed="$failed origin"
fi

# After Windows, never beside it: the laptop's worker checks the schema before
# its junction moves, and Windows activation is what migrates.
case "$failed" in
  *windows*) log "msi: skipped; Windows did not activate" ;;
  *) ship_msi || failed="$failed msi" ;;
esac

echo
log "live commit on every hostname:"
stale=0
for h in "${check_hosts[@]}"; do
  c=""
  for _ in 1 2 3 4 5 6; do
    c=$(live_commit "$h")
    [ "$c" = "$sha" ] && break
    sleep 5
  done
  mark=ok
  [ "$c" = "$sha" ] || { mark=STALE; stale=1; }
  printf '  %-28s %s %s\n' "$h" "${c:0:7}" "$mark"
done

echo
log "timings:"
for target in windows www origin msi; do
  [ -f "$work/$target.time" ] && printf '  %-8s %ss\n' "$target" "$(cat "$work/$target.time")"
done
printf '  %-8s %ss\n' total "$(since "$started")"

[ -z "$failed" ] || die "failed:$failed"
[ "$stale" = 0 ] || die "some hostnames are not serving $short"
log "done: $short is live everywhere"
