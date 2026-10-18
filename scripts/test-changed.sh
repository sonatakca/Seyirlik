#!/usr/bin/env bash
# The tests for what this branch changed, in seconds rather than minutes.
#
#   npm run test:changed            tests that import a changed file directly,
#                                   plus changed test files
#   npm run test:changed -- --deep  every test whose import graph reaches a
#                                   changed file (vitest related)
#   npm test                        everything
#
# `vitest --changed` runs the whole suite as soon as package.json or the vite
# config is among the changes, and building the full import graph means
# transforming every test file first. A change is nearly always tested by
# the files that import it, so that is the default; config edits are named
# and left to `npm test`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

deep=0
if [ "${1:-}" = "--deep" ]; then deep=1; shift; fi

base=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
changed=()
while IFS= read -r file; do
  [ -f "$file" ] && changed+=("$file")
done < <({ git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)

sources=()
config=()
for file in "${changed[@]+"${changed[@]}"}"; do
  case "$file" in
    .claude/*|node_modules/*|dist/*) ;;
    package.json|package-lock.json|vite.config.*|vitest*.config.*|tsconfig*.json) config+=("$file") ;;
    *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs) sources+=("$file") ;;
  esac
done

if [ "${#config[@]}" -gt 0 ]; then
  echo "test:changed: config changed (${config[*]}); run npm test for the whole suite." >&2
fi
if [ "${#sources[@]}" -eq 0 ]; then
  echo "test:changed: no changed source files." >&2
  exit 0
fi

if [ "$deep" = 1 ]; then
  exec npx vitest related --run "${sources[@]}" "$@"
fi

tests=()
for file in "${sources[@]}"; do
  case "$file" in
    *.test.*) tests+=("$file"); continue ;;
  esac
  name=$(basename "$file"); name=${name%.*}
  # Test files that import this module: `from "./name"`, `"../dir/name"`,
  # `"@/…/name"`, with or without an extension.
  while IFS= read -r test; do
    tests+=("$test")
  done < <(git grep --untracked -l -E "(from|import\\(|vi\\.mock\\()[[:space:]]*['\"]([^'\"]*/)?${name}(\\.[a-z]+)?['\"]" \
    -- 'src/*.test.ts' 'src/*.test.tsx' 'scripts/*.test.ts' 2>/dev/null || true)
done
if [ "${#tests[@]}" -eq 0 ]; then
  echo "test:changed: no test imports the changed files; try --deep." >&2
  exit 0
fi
unique=()
while IFS= read -r test; do unique+=("$test"); done < <(printf '%s\n' "${tests[@]}" | sort -u)
tests=("${unique[@]}")
echo "test:changed: ${#tests[@]} test file(s) for ${#sources[@]} changed file(s)." >&2
exec npx vitest run "${tests[@]}" "$@"
