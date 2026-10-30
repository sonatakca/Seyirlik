# Media processing system

Seyirlik processes its own library. This describes what runs, where its state
lives, and how to operate it.

## What it does

For one source file the system probes it, decides what to produce, estimates the
disk it needs, encodes an aligned CMAF/HLS package, validates that package, and
publishes it atomically under a build-versioned path. The source is never
written to.

## Architecture

```
                 admin UI  /dev/media-processing
                     |  REST + Server-Sent Events
        ownApi/processing/processingRoutes.ts
                     |
   processing_jobs   |   jobs (generic durable queue: leases, retry, dedupe)
   jobStore.ts <-----+-----> tasks/jobQueue.ts -> tasks/worker.ts
                     |
        ownApi/processing/jobRunner.ts   (stages, progress, cancellation)
                     |
   renditions/processing/decide.ts       (what to produce, and why)
   renditions/processing/streamPolicy.ts (which languages survive)
   renditions/hardware/detect.ts         (what this machine can encode with)
                     |
   renditions/adaptive/packager.ts       (encode, package, validate, publish)
```

Scheduling and media work are deliberately separate. The generic `jobs` table
already provides leases, retry, cancellation and de-duplication, so a processing
job has one scheduling row there and one domain row in `processing_jobs`. A
worker claims the first and writes the second.

### One encoder, several titles

Most of a title's time is not spent encoding. On the laptop an eleven-minute
episode took about 130 s to plan (frame times, then sample encodes scored with
VMAF), 124 s to encode, and about 70 s to assemble, verify and publish — and with
one job at a time the GPU waited through all but the encode.

So the media lane holds several jobs (`SEYIRLIK_MEDIA_CONCURRENCY`, 3 by
default, 1 for the old behaviour), and the encoder is a slot each build takes
for exactly the work that drives it (`renditions/encoderSlot.ts`):

- **its video epochs**, given back the moment they finish, before audio;
- **its rate probe's sample encodes**, every candidate rate in one hold, encoding
  only the rungs that are scored. The VMAF scoring that follows runs on the CPU
  outside the slot.

Everything else runs beside the encode, so the next title plans and the last
one verifies while this one encodes. Waiters are served in the order they asked.
A build waiting for the slot says so on its planning panel; one paused before its
encode starts waits without the slot, while one paused mid-encode keeps it
(its suspended FFmpeg still holds the GPU's sessions).

The free-space preflight counts what the other builds in the process have
reserved and not yet written. A title that fits on its own but not beside them
waits for them rather than failing.

## Hardware

`detectHardware()` probes by actually encoding a frame at the size processing
will use, because an encoder can be compiled into FFmpeg on a machine with no
accelerator to run it, and one that opens at a thumbnail size can still refuse a
real frame. Adapters that cannot run here are still reported with a reason, so
the page can explain an absent hardware path rather than leaving a blank space.

| Adapter               | Platform | State in this build                           |
| --------------------- | -------- | --------------------------------------------- |
| Apple VideoToolbox    | macOS    | Implemented and proven                        |
| CPU (libx264/libx265) | any      | Implemented and proven                        |
| Intel Quick Sync      | any      | Implemented; reported unavailable when absent |
| NVIDIA NVENC          | any      | Recognised; encoder arguments not written yet |
| AMD AMF               | Windows  | Recognised; encoder arguments not written yet |
| VA-API                | Linux    | Recognised; encoder arguments not written yet |

The adapter interface is the cross-platform contract. Adding NVENC, AMF or
VA-API means writing their encoder arguments in
`renditions/adaptive/encoding.ts` and adding them to `DRIVEABLE_ENCODERS`;
nothing above that layer changes.

## Retention policy

Audio, in order:

1. the source's own default track, whatever language it is in;
2. the best English track, if English is not already kept;
3. the best Turkish track, if Turkish is not already kept.

"Best" prefers more channels, then lossless, then bitrate, then the default
flag. A language already covered is not kept twice. Commentary and audio
description are opt-in and are held apart from the language de-duplication,
because commentary is a different programme rather than another mix of the same
one. Every keep and drop is recorded with its reason.

Subtitles: English and Turkish, plus their forced tracks. SDH is opt-in. Text
subtitles become WebVTT; image subtitles (PGS, VobSub, DVB) are retained and
flagged as needing OCR or burn-in rather than silently discarded.

Generated audio is AAC stereo. This is a compatibility floor, not a preference:
Chromium rejects AAC 7.1 outright, and some Chromium versions fail AAC 5.1 after
a seek. The original file keeps its surround tracks.

## Stages and progress

`waiting → analysing → planning → video → audio → subtitles → packaging →
validating → publishing → complete`

Two different numbers, deliberately kept apart:

- **`overallProgress`** is a weighted sum across the stages, and answers "how far
  through the whole job". It is a high-water mark in both the runner and the
  database, so an out-of-order update or a retry cannot walk it backwards.
- **`encodedSeconds / sourceDurationSeconds`** is how much of the film has
  actually been encoded, and is the only figure shown as encoding progress.

Conflating them is what made a job read 89% while FFmpeg was a third of the way
through the picture — the late stage had been _reached_, not completed. The page
shows the second figure during encoding, and names the stages after it rather than
folding them into one bar: encoding, assembling, validating, publishing.

Encoded media time is `protected + how far into the running epoch`, measured from
that epoch's own start rather than from the protected mark — an epoch being
rebuilt after a corrupted checkpoint sits behind it, and adding the two would
count the same stretch twice.

FFmpeg is read through `-progress` at `-stats_period 0.25`, never by parsing its
console output.

## Live progress

There are two lanes, because the encoder runs in the worker process and the page
is served by the API process, and nothing in memory is shared between them.

- **Transient**, four times a second: the worker writes one small JSON file per
  job (`SEYIRLIK_LIVE_PROGRESS_DIR`, the system temporary directory by default),
  replaced by an atomic rename. It carries a monotonic revision, a timestamp, the
  epoch position, encoded and protected media time, fps, raw and smoothed speed,
  ETA and bytes written. A sample older than six seconds is ignored, so a killed
  worker produces silence rather than a bar that keeps moving.
- **Durable**, about once a second and on every state change: the job row. It is
  what a page opened after a restart sees before the first live sample arrives.

Writing four samples a second to Postgres, per title, for hours, would be
sustained write pressure for data nothing needs to survive a restart — the
durable progress is the checkpoints on disk.

`GET /processing/jobs/:id/stream` is Server-Sent Events carrying both: `progress`
and `stage` from the job row each second, and `live` from the transient file four
times a second. Every stage event carries the job's own sequence number as the SSE
id, so a browser reconnecting with `Last-Event-ID` resumes exactly where it
stopped. The job snapshot endpoint returns the latest live sample too, so a page
that has just reconnected does not have to wait for the next encoder tick — that
wait is what made a refresh look like a stall.

The page interpolates between authoritative samples using the smoothed speed,
bounded by the end of the running epoch and by the elapsed time, and snaps to the
real value on every sample. A stalled encoder therefore reaches the bound and
stops.

## Durable checkpoints

Video is encoded in nominal five-minute epochs, each of which becomes an
immutable, validated checkpoint on disk. The full design — where the cuts fall,
why the seek pre-roll has to be trimmed, the on-disk layout, and how assembly
joins the epochs without a decoder — is in
[adaptive-renditions.md](./adaptive-renditions.md#epochs-and-checkpoints).

What it means for operating the system:

- A crash, a cancel, a killed worker, a restarted server or an unplugged drive
  costs at most the epoch that was running.
- Retry and resume continue from the last durable checkpoint. Neither ever
  deletes one.
- A failure after the encoding is finished — assembly, validation, publication —
  keeps every epoch, so the retry re-encodes no video at all.
- The page shows how much media time is protected, which epoch is running and
  what Retry would actually redo.

## Storage interruption and recovery

The storage watchdog polls every root the work needs — media, rendition, work and
state — and remembers the device each was on, so a _different_ disk mounted at the
same path is treated as absent rather than as the storage coming back.

When a root goes missing, every active job is paused with
`pausedReason = storage-unavailable`, the encoder is ended rather than suspended
(a stopped FFmpeg keeps file descriptors open on a volume that is no longer
there), and the completed checkpoints are left exactly as they are. When the roots
return, those jobs — and only those; a job an operator paused by hand stays paused
— are requeued automatically. No one has to press anything.

Failures are classified rather than guessed at. An `ENOENT` on an output path is a
vanished volume when the volume is gone and a genuinely missing file when it is
not, and no error message distinguishes them, so the storage itself is asked. An
`EIO` or `Input/output error` is treated as disappearing storage even before the
watchdog's next poll, which closes the window in which a job could be marked
permanently failed for an unplugged drive. `ENOSPC` is reported as a full disk,
which is a different problem with a different answer.

## Safety

- The source is opened read-only and never written to.
- A package is built in a staging directory and published by an atomic rename.
- The previous published package stays in place until its replacement is ready.
- Publication happens only after validation passes; a failed package stays as
  diagnostics and never becomes playable.
- Free space is checked before encoding, against the package plus its staging
  copy plus a reserve.
- One active job per media file, enforced by a partial unique index, so two
  workers cannot process the same source and an operator cannot queue it twice.
- Cancellation aborts FFmpeg itself, not just the loop around it, and never
  removes an already-published package.

## Output URLs

Adaptive assets are served `immutable`, so their URL is keyed to the package
build — profile version, source fingerprint and the package's creation stamp.
Rebuilding a package therefore lands on a new URL, and a client holding the old
one misses rather than reading new media through a stale playlist.

Only the asset shapes named in `ADAPTIVE_ASSET_PATTERN`
(`src/server/renditionService.ts`) are servable: the master, the video and audio
renditions, and the WebVTT subtitle renditions. It is an allow-list, so adding a
new rendition kind to the packager means adding it here too — a shape the master
advertises but this pattern does not name returns 404, and a 404 behind an
advertised subtitle group does not degrade to "no subtitles", it fails the whole
title in both engines.

Raising `ADAPTIVE_PROFILE_VERSION` invalidates every existing package at once:
the server declines a stale one and falls back to live transcoding, which for an
HDR source this FFmpeg build cannot do. Repackage the library in the same change
that raises it.

## Operating it

Open **Developer tools → Media Processing** (`/dev/media-processing`).

- The header shows what this machine can encode with, and why anything absent is
  absent.
- Choose a title and press **Preview decision** to see what would happen —
  rungs, encoder, estimated size, and every language keep/drop — without
  queueing anything.
- **Start processing** enqueues it. The queue row shows stage, progress, speed,
  frames per second, time remaining and output size.
- **Inspect** opens the stage timeline, the disk impact, the retained and
  dropped languages, the validation result, and the raw event log behind a
  diagnostics panel.
- **Cancel** stops the encode and keeps every checkpoint; **Retry** re-queues a
  job that failed or was cancelled and continues from the last one, saying which
  point that is rather than offering a bare button.
- A job waiting for a volume says so, says how much is protected, says which five
  minutes will be redone, and says that no action is needed — it resumes on its
  own.

From the command line, the existing CLI still works and shares the same packager
and the same checkpoint engine — there is one implementation, so "why did it
re-encode that" has one answer whichever path built the package:

```sh
npm run media:renditions:process -- --profile adaptive --all-audio-tracks
npm run media:renditions:resume  -- --profile adaptive --source "Movies/Title (2026)/Title (2026).mkv"
npm run media:renditions:status
```

`resume` continues an interrupted title from its last durable five-minute
checkpoint; encoding already protected by one is never repeated, and a single
title can be resumed without a library-wide run. `status` reports the durable
work per title:

```text
legacy=ready  adaptive=failed  epochs=10/31  protected=50:00  current=11  checkpointed=10.7 GiB
```

`cleanup` removes abandoned work — partial epochs nobody is writing, staging from
attempts that have ended, builds keyed to an obsolete profile. It never removes a
valid completed checkpoint, at any age.

To measure what checkpointing costs when nothing goes wrong:

```sh
npm run bench:epochs -- --source "/path/to/movie.mkv" --epoch-seconds 300
```

## Lab

All first-run source, staging, output, logs and reports live under
`/Volumes/Expansion/seyirlik-lab`. Start the isolated server with:

```sh
npm run media:lab:server
```

and verify with `npm run media:lab:verify-matrix` and
`npm run media:lab:verify-http`.
