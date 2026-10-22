#!/usr/bin/env bash
# The integration tests that touch what changed since origin/main, against a
# disposable PostgreSQL that is started once and then reused.
#
#   npm run test:db              tests related to the change
#   npm run test:db -- <paths>   these tests instead
#
# Starting a container per run and migrating from scratch cost about thirty
# seconds before a test ran. The container stays up between runs; each
# integration file still drops and recreates the schema it uses.
set -euo pipefail

name=seyirlik-test-pg
port=55432
url="postgresql://seyirlik:seyirlik@127.0.0.1:$port/seyirlik_test"

if ! docker container inspect "$name" >/dev/null 2>&1; then
  docker run -d --name "$name" -e POSTGRES_USER=seyirlik -e POSTGRES_PASSWORD=seyirlik \
    -e POSTGRES_DB=seyirlik_test -p "127.0.0.1:$port:5432" postgres:17-alpine >/dev/null
elif [ "$(docker container inspect -f '{{.State.Running}}' "$name")" != true ]; then
  docker start "$name" >/dev/null
fi
for _ in $(seq 1 30); do
  docker exec "$name" pg_isready -U seyirlik -q && break
  sleep 1
done

export DATABASE_URL="$url" SEYIRLIK_TEST_DATABASE_URL="$url"
# Serial: two integration files reset the same schema.
if [ "$#" -gt 0 ]; then
  exec npx vitest run --no-file-parallelism "$@"
fi
exec npx vitest run --no-file-parallelism --changed origin/main
