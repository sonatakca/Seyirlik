# Rendition registry in PostgreSQL

The rendition registry maps each source file (relative path, size, mtime,
fingerprint) to the id its packages are stored under, and records whether its
adaptive package is ready. Playback finds every package through it.

Until migration 041 it was one JSON file, `media/.seyirlik/state/registry.json`.
Since Seyirlik moved onto Google Drive, two machines write that file through
two independent rclone mounts (`--vfs-cache-mode full`): the server removes
titles, and MSI registers every title it encodes and marks it ready. On
2026-10-20 one of MSI's saves (temp file, then rename) left a 0-byte object on
Drive, and every encode then failed at video start with "Unexpected end of
JSON input". After the restore, two more MSI saves never reached Drive at all.
Two caches that each think they own a file lose writes, and no file-level
trick (in-place writes, read-back checks, retries) changes that.

## Design

- **Store.** One row in `rendition_registry` holds the whole registry document
  as `jsonb`, plus `revision`, `updated_at`, `updated_by` (the machine name)
  and `imported_from`. A `CHECK (id)` boolean primary key allows only one row.
  Both machines already share this database.
- **One way to change it.** `RenditionRegistryStore.update(mutate)` reads the
  row `FOR UPDATE`, applies `mutate`, validates and writes it back in the same
  transaction. A writer can no longer save a copy it loaded earlier. That was
  a second way of losing writes: the job runner loaded the registry when a job
  started and saved that copy when it published, hours later, undoing every
  change in between.
- **Readers.** `read()` returns a validated copy. `revision()` is a one-column
  query, so playback re-parses the registry only when it changed.
- **Last good copy.** The playback service keeps the last registry it read. A
  failed read (database error, or an empty or invalid file for the file store)
  logs `rendition_registry.read_failed_using_last_good` once per distinct error
  and serves the cached copy. Only a service that has never read the registry
  fails.
- **File store.** `createFileRenditionRegistryStore` keeps the old file
  behaviour behind the same interface, with updates serialised within one
  process. The offline CLI (`media:renditions:*`) and unit tests use it. Every
  runtime component takes the store as an optional dependency, and
  `nativeRuntime` always passes the database one.
- **Seeding.** Running services require an explicit import; they never seed
  themselves from a missing or stale mount. During activation, after old
  writers stop, `seed-rendition-registry.ts` copies the file into the release
  backup directory, validates that copy, then imports it. A missing, empty or
  truncated input stops activation and restarts the previous service. An
  existing database registry is never replaced by deployment.
- **No source removed before playback can find its package.** On 2026-10-20
  Lilyhammer S01E01 published on MSI. Its registry write never reached Drive,
  and the automatic cleanup then removed the source, so playback fell back to
  transcoding a file that was gone. Three changes prevent that order of events:
  - The job runner writes the ready entry _before_ it marks the job succeeded.
    Upload tracking and cleanup only start after that. If the write fails, the
    job fails and is requeued, and the retry only republishes the verified
    package.
  - `removeSource`, shared by the Remove Source button and the automatic
    cleanup, refuses unless `registryGapForPlayback` finds playback's own
    registry entry for these bytes: same lookup as playback, same fingerprint,
    `ready` at the current adaptive profile.
  - The automatic cleanup checks the same thing first. A gap there leaves the
    source undecided rather than kept, so the next worker start asks again.
- **Backups.** The nightly `pg_dump` now covers the registry. The Drive file
  had no backup.

Writers and readers after the change:

| Where                                         | What                                                     | Machine      |
| --------------------------------------------- | -------------------------------------------------------- | ------------ |
| `jobRunner` start                             | `update`: register the source                            | MSI (heavy)  |
| `jobRunner` publish                           | `update`: mark ready, restoring the entry if it has gone | MSI (heavy)  |
| `titleRemoval`                                | `update`: drop the title's entries                       | server (API) |
| `renditionService`                            | `revision` + `read`, last good copy                      | server (API) |
| `removeSource`, `sourceCleanup`               | `read`: playback's entry must be ready before an unlink  | both         |
| `checkpointTruth`                             | `read`, for the id a checkpoint root is named after      | both workers |
| `media:renditions:*` CLI, merge/adopt scripts | file store, offline only                                 | —            |

## Moving over

Migration 041 is additive. Before the first deployment, drain or pause all old
encodes and defer queued encodes until both workers have switched. The importer
refuses while a processing job is running. `deploy/ship.sh` applies migration
041, stops the API, backs up and imports the registry, activates the server,
and stages MSI. Subsequent deployments leave the database registry intact.
Resume the held queue only after both workers are running the new code.

Check the imported item count, readiness and revision on both machines. The
old Drive file remains untouched. The offline CLI still uses files; do not
run it as a live registry writer. Use `scripts/rendition-registry.ts` for
explicit import/export (imports require `--apply`, replacements also require
`--replace`).

Rollback across this cutover requires draining both workers, exporting the
current database registry to local disk, then replacing the old registry
through the server's mount before activating old code. Additive migrations
can remain. Rolling back code alone would read the frozen file and lose
knowledge of packages published since the import; keep the database and its
backup until the rollback window closes.
