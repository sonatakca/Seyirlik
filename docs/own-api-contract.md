# Seyirlik Own API Contract

_The router in `src/server/ownApi` is the authority; this document explains intent and conventions._

## Base path and transport

- Browser base path: `/ownAPI/v1/`
- Example production origin: `https://seyirlik.org/ownAPI/v1/`
- JSON uses UTF-8 and `application/json` unless the endpoint explicitly serves media, images, subtitles, playlists, or WebSocket frames.
- Dates are RFC 3339 UTC strings. Durations and playback positions use integer milliseconds. Bitrates use bits per second. File sizes use bytes.
- Resource IDs are opaque strings; clients must not infer database keys or filesystem paths.
- Clients use relative URLs. Production routing is owned by the reverse proxy, not hard-coded into components.

## Current implementation status

The API is the only backend Seyirlik has: authentication, catalogue, images,
playback, progress, syncplay, trickplay, tasks, and administration are all
implemented and served from `/ownAPI/v1` by `src/server/mediaServer.ts`. There
is no provider gate and no fallback to another server.

Sections below that describe endpoints not present in
`src/server/ownApi/**/routes.ts` are target contracts rather than claims of
implementation; the router is the authority.

## Request correlation

- A client may send `X-Request-Id` only when it matches the documented safe identifier syntax.
- The server generates a cryptographically random request ID otherwise.
- Every response includes `X-Request-Id`.
- JSON success and error bodies include `requestId`.
- The browser client accepts a response only when the outgoing request ID, response header, and JSON envelope ID are all valid and identical. A `204` response must still return the matching header.
- The browser client runtime-validates `GET /health`: status, liveness/readiness booleans, and every dependency status must match the documented finite values. A type-invalid health body is an `INVALID_RESPONSE` even when its envelope and request correlation are valid.
- Logs include the same request ID and a fixed route template, never caller-controlled path segments, authorization headers, cookies, passwords, session tokens, raw media paths, or secrets.

## Success envelopes

Single resource:

```json
{
  "data": { "id": "opaque-id" },
  "requestId": "0190..."
}
```

Collection:

```json
{
  "data": [],
  "pagination": {
    "limit": 50,
    "nextCursor": null,
    "total": 0
  },
  "requestId": "0190..."
}
```

Commands accepted for background work return `202 Accepted`:

```json
{
  "data": { "taskId": "opaque-task-id", "status": "queued" },
  "requestId": "0190..."
}
```

`204 No Content` is reserved for successful commands that intentionally return no representation.

## Errors

```json
{
  "error": {
    "code": "MEDIA_NOT_FOUND",
    "message": "The requested media item could not be found.",
    "details": {
      "fields": {
        "itemId": ["The item does not exist or is not accessible."]
      }
    },
    "requestId": "0190..."
  }
}
```

`details` is optional and must contain only safe, client-actionable values. Responses never expose stack traces, SQL, table names, filesystem paths, FFmpeg arguments/stderr containing paths, internal hostnames, secrets, cookies, or tokens.

Common status codes:

| Status | Meaning                                                        |
| -----: | -------------------------------------------------------------- |
|    200 | Successful read/update with a representation                   |
|    201 | Resource created; include `Location` where applicable          |
|    202 | Durable job accepted                                           |
|    204 | Successful command with no body                                |
|    206 | Authorized byte-range media response                           |
|    400 | Invalid JSON/query/path syntax                                 |
|    401 | No valid native session                                        |
|    403 | Authenticated but not authorized or CSRF rejected              |
|    404 | Resource absent or intentionally hidden by authorization       |
|    409 | Stale progress write, conflicting state, or unavailable source |
|    413 | Request body too large                                         |
|    416 | Invalid/unsatisfiable range                                    |
|    422 | Structurally valid request that fails field validation         |
|    429 | Rate limited; include `Retry-After`                            |
|    500 | Sanitized internal failure                                     |
|    503 | Dependency/readiness failure                                   |

## Pagination, filtering, and sorting

- Cursor pagination is the default: `?limit=50&cursor=...`.
- `limit` defaults to 50 and is capped at 200 unless a route states otherwise.
- Responses contain `nextCursor`; clients treat cursors as opaque and do not persist them indefinitely.
- Stable sort keys are explicit, e.g. `sort=title&order=asc`.
- Repeated filter parameters are OR within one field and AND across fields unless documented otherwise.
- Search uses `q`; empty/whitespace-only queries are rejected.

## Authentication and browser security

- Media users authenticate with Seyirlik credentials held in PostgreSQL. There is no other authentication path and no rollback target.
- Usernames are normalized with Unicode NFKC, trimmed, and lower-cased with the `en-US` locale before comparison. The normalized value is unique and case-insensitive; display names retain their own presentation form.
- Password hashes use Argon2id with 64 MiB memory, three iterations, one lane, and a 32-byte output. Parameters and salt are encoded by Argon2 in each hash. Plaintext passwords are never persisted and there is no weak fallback.
- Browser sessions use an opaque random token in a `HttpOnly`, `Secure` (production), `SameSite=Lax`, path-scoped cookie. Only a keyed hash of the token is stored server-side.
- Session tokens contain 256 bits of cryptographic randomness. Sessions have a 30-day absolute lifetime and a sliding seven-day idle lifetime. Refresh rotates the token atomically; presenting a superseded token revokes its complete token family.
- State-changing cookie-authenticated requests require a signed double-submit CSRF cookie/header tied to the active session-token hash plus strict Origin/Referer validation. Login has no prior session token, so it requires the same strict Origin/Referer check and `application/json` body validation rather than a session-bound CSRF token.
- In `NODE_ENV=production`, CORS is same-origin by default: no cross-origin caller is trusted unless `SEYIRLIK_ALLOWED_ORIGINS` explicitly replaces the empty production allowlist. An explicitly empty variable also enforces same-origin-only behavior. Configured entries are normalized HTTP(S) origins; wildcard, opaque, credential-bearing, and path-bearing values are rejected. Direct HTTP(S) requests derive their effective origin from the transport and `Host` header. TLS reverse-proxy deployments set the trusted canonical `SEYIRLIK_PUBLIC_ORIGIN`; forwarded headers are not trusted implicitly. Non-production defaults include the known local development and Seyirlik origins for compatibility. Credentials are never combined with wildcard origins.
- Login is process-locally rate-limited to five attempts per five minutes by normalized account identifier and direct socket address; successful login clears that account/address bucket. Refresh is limited to 30 attempts per minute by direct socket address. Both stores are bounded to 10,000 entries. Arbitrary forwarding headers do not affect these keys. This is defense in depth, not distributed rate limiting; production should add shared proxy/Redis/PostgreSQL protection before horizontal scale.
- Disabled users, expired/revoked sessions, revoked devices, and permission changes are checked server-side for every protected request and media fetch.
- `POST /auth/refresh` rotates tokens; reused superseded tokens revoke the session family.

### Implemented native identity contracts

- `POST /auth/login` accepts only `application/json` with `username`, `password`, and optional `deviceDescription` (maximum 200 characters). Unknown fields, malformed JSON, bodies above 16 KiB, and unsupported media types are rejected. Success returns `{ data: { user }, requestId }` and creates both cookies.
- `GET /auth/me` returns the same minimal user DTO (`id`, normalized `username`, `displayName`, `isAdministrator`) or `401 AUTH_REQUIRED`.
- `POST /auth/refresh` requires the session cookie, exact same-origin evidence, and matching `X-CSRF-Token`/CSRF cookie. Success rotates the durable session token and both cookies atomically.
- `POST /auth/logout` is idempotent, revokes the active session family when present, clears both cookies, and returns `204` with the matching `X-Request-Id` header. `POST /auth/logout-all` additionally revokes every session for the current user.
- `GET /auth/csrf` requires a valid session and reissues a signed CSRF token in both the response envelope and readable CSRF cookie.
- Production cookies are `__Secure-seyirlik_session` (`HttpOnly`) and `__Secure-seyirlik_csrf`; development uses the same attributes except `Secure` and the `__Secure-` prefix so loopback HTTP works. Both are `SameSite=Lax`, scoped to `/ownAPI/v1/auth`, and carry explicit `Expires` and `Max-Age` values.
- All auth responses use `Cache-Control: no-store`. API DTOs and logs exclude password hashes, database rows, raw session tokens, cookies, connection URLs, and CSRF/session secrets.

## Health and readiness

### `GET /ownAPI/v1/health`

Public, non-sensitive liveness and dependency summary:

```json
{
  "data": {
    "status": "ok",
    "alive": true,
    "ready": false,
    "checks": {
      "database": "unavailable",
      "jobs": "disabled",
      "ffmpeg": "available",
      "ffprobe": "available",
      "mediaStorage": "available",
      "generatedStorage": "writable"
    }
  },
  "requestId": "0190..."
}
```

Values are `available`, `unavailable`, or `disabled`. Both database and durable jobs must be `available` before `ready` can be true; `jobs: disabled` is not ready. The endpoint exposes no versions, binary paths, storage paths, credentials, connection strings, hostnames, or error details. Responses use `Cache-Control: no-store`. Dependency probes are cached briefly, concurrent probes are coalesced, and every dependency probe fails closed after a bounded timeout. Process liveness returns HTTP 200; an optional orchestrator-only readiness route may return 503 when mandatory checks fail.

The app bootstrap always uses this endpoint; there is no provider to select. It validates the health DTO at runtime, treats `alive: true` as bootstrap success even while `ready` is false, and has no other probe to fall back to. Local Vite development proxies `/ownAPI/*` to `SEYIRLIK_OWN_API_UPSTREAM` (default `http://127.0.0.1:43110`) and excludes that namespace from service-worker navigation fallback. Production must route `/ownAPI/v1/*` to the persistent backend at the same public origin before enabling native mode; an SPA rewrite is not an API route.

## Endpoint catalogue

The following is the target native surface. Endpoints are protected unless marked public.

### Authentication, users, and devices

| Method | Path                   | Purpose                                             |
| ------ | ---------------------- | --------------------------------------------------- |
| POST   | `/auth/login`          | Username login; create cookie session               |
| POST   | `/auth/logout`         | Revoke current session and clear cookie             |
| POST   | `/auth/logout-all`     | Revoke all current-user sessions/devices per policy |
| POST   | `/auth/refresh`        | Rotate native session token                         |
| GET    | `/auth/me`             | Current user, roles, effective library permissions  |
| GET    | `/auth/csrf`           | Reissue the active session's CSRF token             |
| GET    | `/devices`             | Current user's devices and session summaries        |
| DELETE | `/devices/:deviceId`   | Revoke a device and its sessions                    |
| GET    | `/admin/users`         | Paginated user administration                       |
| POST   | `/admin/users`         | Admin-created user                                  |
| PATCH  | `/admin/users/:userId` | Role, disabled state, profile, library permissions  |

### Libraries and catalogue

| Method | Path                                      | Purpose                                               |
| ------ | ----------------------------------------- | ----------------------------------------------------- |
| GET    | `/libraries`                              | Libraries visible to current user                     |
| GET    | `/libraries/:libraryId`                   | Visible library details                               |
| GET    | `/libraries/:libraryId/items`             | Paginated library catalogue                           |
| POST   | `/admin/libraries`                        | Create library and roots                              |
| PATCH  | `/admin/libraries/:libraryId`             | Update library/settings/roots                         |
| DELETE | `/admin/libraries/:libraryId`             | Safe delete; source media is never deleted implicitly |
| POST   | `/admin/libraries/:libraryId/scan`        | Queue reconciliation and return task ID               |
| GET    | `/admin/libraries/:libraryId/scan-status` | Current/recent scan state                             |
| GET    | `/items/:itemId`                          | Authorized item details                               |
| GET    | `/items/:itemId/streams`                  | Media files, technical streams, selectable tracks     |
| GET    | `/items/:itemId/chapters`                 | Authorized chapters                                   |
| GET    | `/movies`                                 | Paginated movies                                      |
| GET    | `/series`                                 | Paginated series                                      |
| GET    | `/series/:seriesId/seasons`               | Ordered seasons                                       |
| GET    | `/seasons/:seasonId/episodes`             | Ordered episodes                                      |
| GET    | `/home`                                   | Stable home-screen aggregate DTO                      |
| GET    | `/home/continue-watching`                 | Resume candidates                                     |
| GET    | `/home/next-up`                           | Next episode candidates                               |
| GET    | `/search`                                 | Authorized search                                     |
| GET    | `/genres`                                 | Authorized genre facets                               |
| GET    | `/people/:personId`                       | Person and visible credits                            |
| GET    | `/collections`                            | Visible collections                                   |

### Metadata and images

| Method | Path                                     | Purpose                                    |
| ------ | ---------------------------------------- | ------------------------------------------ |
| GET    | `/metadata/items/:itemId/candidates`     | Candidate identification matches           |
| POST   | `/admin/items/:itemId/identify`          | Select provider match                      |
| POST   | `/admin/items/:itemId/metadata/refresh`  | Queue safe metadata refresh                |
| PATCH  | `/admin/items/:itemId/metadata`          | Edit fields and locks                      |
| POST   | `/admin/items/:itemId/images/refresh`    | Queue image refresh                        |
| PUT    | `/admin/items/:itemId/images/:imageType` | Select/replace image                       |
| GET    | `/images/:imageId`                       | Authorized cached image with cache headers |
| GET    | `/items/:itemId/images/:imageType`       | Resolve current authorized item image      |

### Server lifecycle

| Method | Path                    | Purpose                                   |
| ------ | ----------------------- | ----------------------------------------- |
| GET    | `/admin/system/restart` | Whether a restart is available, and how   |
| POST   | `/admin/system/restart` | Restart the server; `202` before shutdown |

`GET` returns `{ "mode": "respawn" | "supervisor" | "disabled", "available":
true, "inProgress": false }`. It succeeds even when restarts are unavailable, so
a client can explain why rather than discovering it by pressing the button.

`POST` answers `202` with `{ "status": "restarting", "mode": … }` **before** the
server stops: the response has to reach the caller while the socket is still
open, so the shutdown is scheduled behind a short grace period. A request while
a restart is already under way is accepted again rather than rejected. When the
mode is `disabled` the response is `409 RESTART_UNAVAILABLE`.

A client that has sent the `POST` should wait for the server to stop answering
`GET /health` and then to answer it again with `ready: true`, rather than
reloading straight away — for a moment after the `202`, the old process is still
healthy.

### NFO export

Library scans generate sidecars by default; these administrator-only endpoints
preview or manually repeat the same safe export. See the README for modes and
media-root storage policy.

| Method | Path                                     | Purpose                                           |
| ------ | ---------------------------------------- | ------------------------------------------------- |
| GET    | `/admin/items/:itemId/nfo/preview`       | Generated XML and the path it would be written to |
| POST   | `/admin/items/:itemId/nfo/export`        | Queue `nfo.export.item`; `202` with a task id     |
| POST   | `/admin/libraries/:libraryId/nfo/export` | Queue `nfo.export.library`; `202` with a task id  |

Both export endpoints accept an optional body of `{ "force": true }`, which is
the only way to replace an .nfo that this server did not write — a legacy
Jellyfin, Radarr, Sonarr or hand-authored file. Without it such a file is
reported as a conflict and left untouched. An unknown body field is a `422`.

A preview response describes one item:

```json
{
  "data": {
    "itemId": "…",
    "kind": "movie",
    "mode": "sidecar",
    "overwritePolicy": "managed-only",
    "destination": "media-root",
    "files": [
      {
        "relativePath": "Movies/Dune (2021)/movie.nfo",
        "xml": "<?xml version=\"1.0\" …",
        "existing": "foreign",
        "identical": false
      }
    ]
  },
  "requestId": "0190…"
}
```

`mode` is one of `disabled`, `preview`, `generated`, `sidecar`; `destination` is
`media-root`, `generated-storage`, or `none`. `existing` is `absent`, `managed`,
`foreign`, or `unreadable`. A `skipped` field appears instead of files when the
item cannot own an .nfo — `unsupported-kind`, `no-title-root`,
`no-primary-file`, `no-season-directory` — or when a Radarr/Sonarr instance owns
the library (`arr-managed`).

Every path in an NFO response is relative to the export root. Absolute host
paths are never returned, including in conflict reports.

The task result for either export job carries the counts and a bounded conflict
list:

```json
{
  "created": 12,
  "updated": 3,
  "unchanged": 480,
  "skippedConflict": 2,
  "skippedNotApplicable": 9,
  "failed": 0,
  "mode": "sidecar",
  "itemsConsidered": 506,
  "conflicts": [
    {
      "itemId": "…",
      "relativePath": "Movies/Dune (2021)/movie.nfo",
      "reason": "foreign-file"
    }
  ],
  "conflictsTruncated": false
}
```

A conflict `reason` is `foreign-file`, `symlink`, `not-a-regular-file`,
`unsafe-path`, or `outside-root`. The counts stay exact when
`conflictsTruncated` is true.

### Playback and user state

| Method   | Path                                                    | Purpose                                                        |
| -------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| POST     | `/playback/plan`                                        | Deterministic capability-based plan with reason codes/messages |
| POST     | `/playback/sessions`                                    | Create authorized Direct Play/HLS session                      |
| GET      | `/playback/sessions/:sessionId`                         | Session status and sanitized diagnostics                       |
| DELETE   | `/playback/sessions/:sessionId`                         | Stop/cancel session                                            |
| GET/HEAD | `/playback/sessions/:sessionId/file`                    | Session-bound original byte-range delivery                     |
| GET/HEAD | `/playback/sessions/:sessionId/master.m3u8`             | Authorized HLS playlist                                        |
| GET/HEAD | `/playback/sessions/:sessionId/:segment`                | Authorized HLS init/segment                                    |
| GET      | `/playback/sessions/:sessionId/subtitles/:streamId.vtt` | Authorized extracted/converted subtitle                        |
| PUT      | `/progress/:itemId`                                     | Sequence/timestamp-protected progress update                   |
| GET      | `/books/:itemId/position`                               | The reader's place in a book, shared by all their devices      |
| PUT      | `/books/:itemId/position`                               | Save a book place; a later `readAt` already stored wins        |
| POST     | `/items/:itemId/played`                                 | Mark played                                                    |
| DELETE   | `/items/:itemId/played`                                 | Mark unplayed                                                  |
| POST     | `/favourites/:itemId`                                   | Add favourite                                                  |
| DELETE   | `/favourites/:itemId`                                   | Remove favourite                                               |
| GET      | `/items/:itemId/trickplay`                              | Trickplay set and frame mapping                                |
| GET      | `/trickplay/:setId/sprites/:spriteIndex`                | Authorized sprite image                                        |
| POST     | `/admin/items/:itemId/trickplay/regenerate`             | Queue regeneration                                             |

A book position is `{ cfi, place, fraction, readAt }`: `place` is `{ section, block, offset }` (the first block still on screen and the px from its top to the top of the screen), `fraction` is how far through the book (0 to 1), and `readAt` is when the reader was there (ms since the epoch on PUT, ISO 8601 in replies), capped at the server's clock. A PUT always answers `{ accepted, position }` with the place now on record, so a device whose save lost learns the later place instead of getting an error. Any item that is not a book the caller can see answers 404.

**Narration** (see `docs/narration.md`). `GET /books/:itemId/narration` answers `{ version, state, voice, requestedAt, finishedAt, progress, error, sections: [{ section, duration, version }] }`. `state` is `queued`, `narrating`, `ready`, `failed` or `outdated`. An administrator also gets `narratorSeenAt`. A book with no narration answers 404, and the reader shows no listen button. `GET /books/:itemId/narration/sections/:section/words` answers `{ version, section, duration, words }`, where each word is `[block, start, end, t0, t1]`. `block` counts blocks the way `getEpubBlocks` does, `start` and `end` are character offsets into that block's `epubBlockText`, and `t0` and `t1` are ms into the section's audio. `GET /books/:itemId/narration/sections/:section/audio` serves that audio (AAC in MP4) with byte ranges. Both URLs carry `?v=<version>`, so a replaced section is fetched afresh and an unchanged one is cached for good. An administrator can `POST /books/:itemId/narration` to ask for one (409 if one is already queued, under way or ready), `DELETE` it with its audio, and `GET /admin/narrator` (`{ seenAt }`) to see whether a narrator is connected. For the review page: `GET /admin/narrations` lists narrated books (`{ itemId, title, state, sections, duration, requestedAt }`); `GET /admin/books/:itemId/narration/review` answers `{ narration, sections: [{ section, duration, version, lines }], pronunciations }`, where `lines` is null until the narrator sent them and each line is `{ chunk, block, start, end, text, at, duration, heard, spoken, match, lift, reasons, unsure, takes, retakes, asked }`; `POST /admin/books/:itemId/narration/retakes` (`{ chunk }`) asks for one line again (`{ chunk, count }`); `GET /admin/narration/pronunciations`, and `PUT` (`{ spoken }`) or `DELETE /admin/narration/pronunciations/:word` (`{ word, spoken?, books }`, `books` being how many narrations went back to be read). The narrator's own routes, under `/narrator/*`, take only a narrator key as a bearer token (`access: "narrator"` in the router) and are described in `docs/narration.md`.

A playback-plan response uses native enum values `DIRECT_PLAY`, `REMUX`, `DIRECT_STREAM`, or `TRANSCODE`, and includes both `reasonCodes` and `reasons`. It never returns a raw source path.

### Tasks, activity, sessions, and settings

| Method | Path                                | Purpose                                |
| ------ | ----------------------------------- | -------------------------------------- |
| GET    | `/admin/tasks`                      | Job history and filters                |
| GET    | `/admin/tasks/:taskId`              | Job status/progress/safe error         |
| POST   | `/admin/tasks/:taskType/run`        | Queue manual job                       |
| POST   | `/admin/tasks/:taskId/cancel`       | Request cancellation                   |
| GET    | `/admin/task-schedules`             | Recurring schedules                    |
| PATCH  | `/admin/task-schedules/:scheduleId` | Validate/update schedule               |
| GET    | `/admin/activity`                   | Product activity events                |
| GET    | `/admin/sessions`                   | Active user/playback sessions          |
| GET    | `/admin/logs`                       | Sanitized structured application logs  |
| GET    | `/admin/transcodes`                 | Active/recent transcodes               |
| POST   | `/admin/sessions/:sessionId/stop`   | Administrative session termination     |
| GET    | `/settings`                         | Current user's safe effective settings |
| PATCH  | `/settings`                         | Current user's allowed settings        |
| GET    | `/admin/settings`                   | Safe server settings; secrets omitted  |
| PATCH  | `/admin/settings`                   | Validated server settings              |

### SyncPlay

A party is one group timeline owned by the server; each browser tab is one
participant, identified by a client id it generates and keeps for the tab's
lifetime (so a reload rejoins as the same participant). The timeline is stored
in `syncplay_groups` and survives a restart; participants, readiness and
presence are live state in the server process. The model and its timing rules
are documented in `src/server/ownApi/syncplay/syncplayState.ts`.

| Method | Path                                         | Purpose                                                                           |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/syncplay/groups`                           | Create a party from the creator's current position; the creator joins             |
| POST   | `/syncplay/groups/:groupId/join`             | Join or rejoin (idempotent per client id) after an item-access check              |
| GET    | `/syncplay/groups/:groupId/events?clientId=` | Server-sent events: `snapshot`, `ping`, `closed`, `superseded`                    |
| POST   | `/syncplay/groups/:groupId/commands`         | `play`, `pause`, `seek`, `setItem`; per-client `sequence`; returns the snapshot   |
| POST   | `/syncplay/groups/:groupId/status`           | Readiness (`loading`/`ready`/`stalled`/`away`) and keepalive; returns server time |
| POST   | `/syncplay/groups/:groupId/leave`            | Leave; the last participant leaving closes the party                              |
| DELETE | `/syncplay/groups/:groupId`                  | End the party for everyone (creator or administrator)                             |

Every `snapshot` is the complete group state, ordered by `(epoch, version)`;
`epoch` changes when the server process does. A command from a client whose
`sequence` is not above its last accepted one is not applied
(`accepted: false`, with `lastSequence` so a reloaded tab can resume counting).
A participant must exist before it may stream, command or report
(`404 PARTICIPANT_NOT_FOUND` tells a client to join again).

## Cache and media response rules

- Images include an ETag/content hash, `Cache-Control`, safe content type, and `nosniff`.
- Media supports valid single byte ranges, `Accept-Ranges`, `Content-Range`, correct length/type, HEAD, cancellation, and 416 handling.
- Playlists are session-bound and non-cacheable. Segments may be private-cacheable only within the session lifetime.
- Subtitle responses use `text/vtt; charset=utf-8` and reject invalid stream IDs.
- All media/image/subtitle/trickplay requests repeat authorization and library checks; possession of an item ID is not authorization.

## Compatibility policy

The API contract is camelCase throughout. The client still renders inherited PascalCase view-model shapes (`Id`, `RunTimeTicks`, `UserData`, `MediaSources`), but those live entirely behind `src/api/ownApi/adapters.ts` and are not part of this contract — see `migration-from-jellyfin.md`. Breaking changes require `/v2`; additive optional fields may be introduced in `/v1`.
