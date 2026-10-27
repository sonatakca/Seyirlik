# Acquisition

Turning an approved release decision into a download, through SABnzbd, without
ever sending the same NZB twice.

Seyirlik is the control plane; SABnzbd is the execution engine. Everything
Seyirlik records answers a question SABnzbd cannot — why this download exists,
for what, chosen how, and what to do when it fails — and the coupling to
SABnzbd is two columns wide.

This phase stops at a finished download. It does not import, rename, move,
hardlink or take ownership of anything in media storage; it publishes a path
and leaves it there.

## Layers

```
acquisitionRoutes.ts      admin routes; neither NZB URL nor nzo id leaves here
acquisitionJobs.ts        two handlers on the existing durable job queue
acquisitionService.ts     submit / reconcile / cancel — the idempotency core
acquisitionRepository.ts  PostgreSQL, with conditional state writes
acquisitionState.ts       legal moves, failure classes, retry planning
sabnzbd.ts                the client: one boundary, one place SABnzbd is known
acquisitionConfig.ts      the declaration, read once at startup
```

## Not sending it twice

The problem is not that submission might fail. It is that submission might
_succeed and be lost_ — the NZB arrives, the reply does not, and the obvious
recovery is a second submission that downloads the same release again.

Five things together prevent it:

1. **The key is made when the row is made.** `seyirlik-<row id>`, written in
   the same `INSERT` as the acquisition. There is no moment at which an
   acquisition exists without one, so two workers cannot invent two names for
   the same download.
2. **The key is the job's name in SABnzbd.** A name only Seyirlik would
   generate makes a submission recoverable from SABnzbd's side alone.
3. **Look before sending.** `findByName` runs against the live queue and
   history first; a job already there is adopted, whatever state it is in,
   including finished.
4. **`submitting` is persisted before the network call, not after.** A row that
   dies mid-flight is found in `submitting` on the next pass, which means
   "go and look", never "send it again".
5. **A grace period before concluding it never landed.** SABnzbd does not
   necessarily list a job the instant it accepts one, and concluding too early
   is exactly how the duplicate gets created anyway.

The state write itself is conditional — `WHERE id = $1 AND state = $2` — so of
two workers holding the same acquisition, the second matches no row, is told
so, and stops. No separate lock table has to be kept in step with the row.

## Ownership

Seyirlik acts only on jobs that are both filed under its own SABnzbd category
and named with an idempotency key it generated. Everything else in the queue —
Radarr's, Sonarr's, a job added by hand — is read, reported and never touched.
Cancellation removes the job an acquisition owns and nothing else; a client
never names a SABnzbd identifier, so it cannot reach one.

## Failure

Fourteen failure classes, each mapped to one of three dispositions:

- **retry** — the world was briefly unavailable (client down, indexer down,
  submission timed out, disk full). Exponential backoff, capped at three
  attempts per release. The row waits in `awaiting_retry` with its
  `retry_after` time, and the reconciler hands it back to the submit job once
  that time has passed; a release out of attempts is `failed` instead.
- **try another release** — this release will fail the same way next time
  (missing articles, repair failed, unpack failed, password required). Seyirlik
  does not pick the replacement itself: searching again is a decision, and the
  reconciler's job is to observe.
- **terminal** — retrying cannot help (authentication rejected, removed by
  someone else, cancelled, unrecognised).

`failed` is deliberately not a terminal state. A person may retry it, which
clears the backoff and queues the work immediately.

## Configuration

`SEYIRLIK_SABNZBD` in the non-secret settings file:

```json
{
  "baseUrl": "http://127.0.0.1:8080",
  "apiKeyEnv": "SEYIRLIK_SABNZBD_API_KEY",
  "category": "seyirlik",
  "timeoutMs": 30000
}
```

The declaration _names_ the variable holding the key; the key itself lives in
the protected secrets file, so rotating it changes one value and no code. A
declared client with a missing key stops the process at startup — otherwise it
would present as downloads that are accepted and never start.

Absent configuration is not an error. With no client declared there are no
acquisition routes, no handlers and no reconcile timer: a media server with no
downloader still serves everything it has, and playback must never learn to
depend on SABnzbd. For the same reason the client's reachability is reported on
its own endpoint and is not part of the server's readiness.

### The category is the isolation

The category named here is where Seyirlik files its jobs, and its directory is
where completed downloads land. It must be Seyirlik's own — not `movies` or
`tv`, which belong to Radarr and Sonarr — and it must point somewhere that is
not media storage. Phase 5 is what moves anything into the library.

## Reconciliation

SABnzbd is polled, not subscribed, because no callback survives a restart of
either side. A job can therefore move several states between two reads, so
forward skips are legal and backward moves are refused. Re-observing the same
state is legal too — a poll that finds nothing new must not be an error, and
must not grow the audit trail.

The reconciler reads the queue and history once per batch rather than once per
row: SABnzbd is one process on one machine, and asking it per acquisition turns
a backlog into a stampede. When SABnzbd is unreachable it changes nothing at
all, rather than recording an absence as a failure.

## Live progress and pauses

The live progress endpoint reads SABnzbd’s queue-wide pause as well as each
job’s status. A globally paused queue reports waiting and downloading jobs as
paused, without a speed or ETA; post-processing already in history continues
to report its actual step. Submission does not resume the downloader: an
operator’s pause must remain effective until they choose to resume it.

When work is waiting, nothing is moving, and every news server SABnzbd holds
is set aside or carries an error, the endpoint calls those jobs `stalled` and
names the servers with SABnzbd's own error. SABnzbd's slots still say
"Downloading" then, so only its server status (`mode=status`, asked only when
the queue has no speed) tells a dead provider from a pause between articles.
The figures stay SABnzbd's own; there is no speed or ETA.

History failures have a distinct `failed` progress stage. The page shows the
failure immediately and refreshes the acquisition list, even before worker
reconciliation. A failed job never fills a success bar or displays `0 / 0 · 100%`.

## Steering the queue

The Acquisitions page is the queue a person steers, not SABnzbd's own UI. SABnzbd
names each job `seyirlik-<row id>`, because the name is the recovery handle
above; the page names it by what it is for — title, then `S01E03`, the season
or the year — with the release underneath. The job names in SABnzbd are left as
they are.

Four controls, each going through the server so that no SABnzbd identifier ever
reaches a browser:

- `POST /acquisitions/:id/pause` and `/resume` hold or release one job.
- `POST /acquisitions/:id/move` with `{ position }` puts one job at a place in
  SABnzbd's queue, counted from 1 as `queuePosition` is. SABnzbd's `switch`
  removes the job and inserts it at that index; a move onto its own place is
  skipped, since SABnzbd answers that with -1.
- `POST /acquisitions/client/pause` and `/resume` stop or start the whole
  downloader, as its own pause button does.

The first three act only on a job that is in the queue, filed under Seyirlik's
category and named with the row's key — the same ownership rule as
cancellation — and answer 409 otherwise. The client switch is the one control
that reaches other jobs, deliberately: it is the operator's switch for the
downloader, and nothing is removed or reordered.

The live progress endpoint now gives every queued job its place, a waiting
job SABnzbd's cumulative estimate of when it will be done, and the queue's
remaining bytes and free space. The page reorders by dragging (the processing
queue's `useQueueSortable`), by the arrow keys on the handle, or with "move to
the top".

These controls reach whichever SABnzbd `SEYIRLIK_SABNZBD.baseUrl` names on the
machine serving the API. They are only meaningful when that is the SABnzbd the
heavy worker submits to.

## What is recorded

Three tables. `acquisitions` is the row and its current state.
`acquisition_decisions` holds the evidence that chose this release — profile,
score, reasons, and the policy as a **snapshot** rather than a reference, so
editing a profile later cannot rewrite why something was downloaded last month.
`acquisition_events` is append-only: every state the row passed through, and
why.

## Handing over

`GET /acquisitions/ready-for-import` lists acquisitions that finished
downloading and have a path. That is the whole interface to the import phase,
and nothing in this phase acts on it.
