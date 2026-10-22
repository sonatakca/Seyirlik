# Windows deployment

How Seyirlik runs unattended on Windows. Nothing here is host-specific, and no
credential value appears in this file or in any command it describes.

## Topology

```
SeyirlikPostgres  (PostgreSQL, NT AUTHORITY\NetworkService)
        ↑ service dependency
SeyirlikServer    (node … mediaServer.ts, NT SERVICE\SeyirlikServer)
SeyirlikWorker    (node … mediaWorker.ts, NT SERVICE\SeyirlikWorker)
```

The server and the worker are separate processes that meet only in the job
queue in PostgreSQL, so restarting the site does not abandon an encode and a
wedged encoder does not take playback down. Set `SEYIRLIK_RUN_WORKER=false`
whenever the worker runs as its own service, or the API process will run one
too and you will have two.

### Splitting the worker across two machines

When the library lives on a cloud mount (an rclone mount of Google Drive) the
always-on server cannot download or encode, and a second machine that is
switched on by hand does that instead. Both workers claim from the same queue:

| Setting                             | Server  | Second machine |
| ----------------------------------- | ------- | -------------- |
| `SEYIRLIK_WORKER_ROLE`              | `light` | `heavy`        |
| `SEYIRLIK_CATALOGUE_DELETE_MISSING` | `false` | `false`        |
| `SEYIRLIK_LIBRARY_RESCAN_MINUTES`   | `10`    | unset          |

- `light` runs scans, probes, TMDB metadata and artwork, subtitles and NFO.
  `heavy` runs downloads, imports, encodes, trickplay, intro detection and its
  own scratch and download clean-up. A job waits in the queue until a worker
  that takes it is running. The default, `all`, is one machine doing both.
- Availability is judged only from files the server's scan finds. The server's
  mount shows a file once it has finished uploading, so the scheduled scan
  shows a title when it is really on Drive and hides it again if its files go.
  A succeeded or failed processing job is not consulted.
- With `SEYIRLIK_CATALOGUE_DELETE_MISSING=false` a missing title is hidden,
  never deleted, however long it stays missing. Its watch history and
  metadata are kept for when it comes back.

Both are supervised by NSSM, which is invoked from a machine-wide copy. Node is
executed **directly**: running it through `npm` puts a shell between the
supervisor and the server, so the supervisor watches the wrapper, kills it,
declares the job dead and starts a replacement while the real server still
holds the port.

Restart is unconditional. A restart requested from the Server Control page is a
_clean_ exit, so a restart-only-on-failure policy would turn that button into a
stop button. `AppThrottle` bounds the loop; a process that dies inside that
window is reported as failed to start rather than restarted forever.

`AppStopMethodConsole` must exceed the server's own shutdown deadline
(`SHUTDOWN_DEADLINE_MS`, 15 s) or the supervisor will escalate past a shutdown
that was going to finish. NSSM's console stop reaches Node's `SIGINT` handler,
which is what makes graceful shutdown work at all on Windows.

## Layout

| Path                                          | Holds                       |
| --------------------------------------------- | --------------------------- |
| `C:\Program Files\Seyirlik\ffmpeg\bin`        | FFmpeg and ffprobe          |
| `C:\Program Files\Seyirlik\bin`               | NSSM                        |
| `C:\ProgramData\Seyirlik\config\settings.env` | non-secret settings         |
| `C:\ProgramData\Seyirlik\secrets\secrets.env` | credentials                 |
| `C:\ProgramData\Seyirlik\postgres\data`       | database cluster            |
| `C:\ProgramData\Seyirlik\logs`                | service and PostgreSQL logs |
| `C:\ProgramData\Seyirlik\generated`           | generated storage           |
| `C:\ProgramData\Seyirlik\scratch`             | `TEMP` for both services    |

Configuration is split because the two halves have different lifetimes and
different readers. Node takes `--env-file` more than once and later files win,
so the services load settings then secrets. Only the secrets file is restricted
to the service accounts; the folder above it is not readable by them at all, so
a future credential added beside it is not automatically exposed.

## Service identity

Each service runs as its own **virtual account** — `NT SERVICE\SeyirlikServer`
and `NT SERVICE\SeyirlikWorker`. There is no password to store, leak or rotate,
and the two services cannot reach each other's resources.

Granted, and nothing else:

| Resource                                                | Right                                     |
| ------------------------------------------------------- | ----------------------------------------- |
| `C:\ProgramData\Seyirlik`                               | traverse only, not inherited              |
| `config\`                                               | read                                      |
| `secrets\secrets.env`                                   | read — the single file, never the folder  |
| `media\`                                                | read (the media root is never written to) |
| `logs\`, `generated\`, `scratch\`                       | modify                                    |
| application checkout, Node, `C:\Program Files\Seyirlik` | read and execute                          |

PostgreSQL runs as `NT AUTHORITY\NetworkService` and owns its own cluster
directory. It refuses to run with an administrator token and re-executes itself
under a restricted one, which has two practical consequences: initialise the
cluster **as the account that will own it**, and never copy or move PostgreSQL's
program directory from somewhere with a restrictive ACL — a move carries the
source ACL, and the restricted token then cannot read the binaries. The symptom
is a silent crash with no output and no event-log entry.

## Database

Local only (`listen_addresses = '127.0.0.1'`), `scram-sha-256` for every
`pg_hba.conf` line including the replication defaults, no `trust` anywhere. The
application connects as a dedicated role that owns its own database and is
`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`; `CONNECT` is
revoked from `PUBLIC`.

## Migrations

Neither service migrates. Both _validate_ that the schema is current and refuse
to start otherwise, so a stale schema is a loud failure rather than two
processes racing to change it. `runMigrations` takes a PostgreSQL advisory lock
and runs in a transaction, so even two concurrent operators serialise.

Migrating is a deliberate deployment step, run before the services start:

```
node --env-file=<settings> --env-file=<secrets> --import tsx scripts/run-own-api-migrations.ts
```

## FFmpeg

Installed machine-wide and addressed by absolute path through
`SEYIRLIK_FFMPEG_PATH` / `SEYIRLIK_FFPROBE_PATH`. A per-user package manager
install is invisible to every service account no matter which user set it up,
and the service will start healthy in every respect except that it can never
encode. Compatibility is capability-based, not version-based — see
[FFmpeg runtime](./ffmpeg-runtime.md). `GET /ownAPI/v1/processing/hardware`
probes each encoder lane by actually encoding, and is the check to run after
changing anything about FFmpeg.

## Health

`/ownAPI/v1/health` separates `alive` from `ready` and names each dependency
(`database`, `jobs`, `ffmpeg`, `ffprobe`, `mediaStorage`, `generatedStorage`).
Readiness covers what the process needs to do its own work; it deliberately
does not depend on external providers, so a provider outage is not reported as
the server being dead.

## Backup

The recoverable state is the database, the configuration and the secrets.
Generated storage is a cache and is rebuilt. Media is never written by
Seyirlik. Back up with `pg_dump`, and keep the secrets file with its ACL.

## Control dashboard

`SeyirlikControl` is a separate service that edits `settings.env` and
`secrets.env`, restarts the services and shows the health report and logs,
over Tailscale only. It is installed with `deploy\windows\install-control.ps1`.
See [Control dashboard](./control-dashboard.md).
