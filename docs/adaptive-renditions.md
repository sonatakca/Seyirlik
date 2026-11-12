# Aligned adaptive renditions

Seyirlik's `cmaf-hls-aligned-v1` profile provides seamless quality changes with
one persistent player pipeline. It is a second generation alongside the existing
complete MP4 ladder, not an in-place conversion.

## What is generated

For each eligible title, the timeline is cut into nominal five-minute
**epochs**. One ffmpeg invocation per epoch decodes that stretch of the source
once and writes every rung of the ladder from it, so the shared-decode advantage
that made the original design fast is kept intact. What changes is that an epoch
which finishes is _durable_: validated, manifested and immutable. Losing an
external drive at 00:52 of a 02:30 title now costs the two minutes since the last
checkpoint rather than fifty-two minutes of encoding.

Across the whole title this produces:

- video-only H.264 SDR or HEVC Main 10 HDR renditions;
- a closed, forced two-second GOP shared by every video rendition;
- one AAC rendition per selected source audio track (the default track unless
  `--all-audio-tracks` is requested);
- fMP4/CMAF HLS with one `media.m4s` file per rendition and byte ranges in the
  media playlist;
- a measured multivariant master with bandwidth, resolution, frame rate, RFC
  6381 codec strings, audio groups and HDR range signalling.

The single-file byte-range layout avoids creating hundreds of thousands of tiny
segment files. Every package is built under the work root, validated deeply, then
promoted as an immutable version. `current-adaptive.json` is swapped only after
validation passes. The legacy `current.json` pointer is never changed by adaptive
processing.

Audio is no longer muxed alongside the video ladder. It is a separate whole-title
stage with its own checkpoint, because a soundtrack failing must not take eight
video renditions with it, and a video epoch being redone must not re-encode audio
it has already produced.

## Epochs and checkpoints

### Where the cuts fall

A nominal boundary is a round number; a source's frames are not. At 23.976 fps no
frame lands on 00:05:00 at all — the neighbours are 299.966 and 300.008 — so the
planner probes the source's own packet timestamps around each boundary and cuts
**midway between the two straddling frames**, where no frame exists. That is not
a tolerance being relaxed: it is the only point in the interval where a
microsecond of rounding cannot decide whether a frame is encoded twice or not at
all. Boundaries are snapped to a whole number of two-second segments first, so a
cut never lands inside a segment.

The result is written to `plan.json` before any encoding, and every restart reads
it back. The same source bytes, adaptive profile and timeline policy always
produce the same boundaries, which is what makes the epochs on disk joinable to
the ones a later attempt would produce.

A tail shorter than half an epoch is folded into the epoch before it, so the last
epoch of a title may run up to one and a half times the target rather than
spending an FFmpeg start and a validation pass to protect four seconds.

### Encoding one epoch

```text
-ss <midpoint cut>  -i source
    trim=start=0,setpts=PTS-STARTPTS   drop the seek pre-roll, rebase to zero
    split -> 2160p 1440p 1080p 720p 480p 360p 240p 144p
-t  <first kept frame → next cut>
```

The `trim` is load-bearing and was not obvious. FFmpeg's accurate `-ss` does not
hand the filter graph only the frames from the seek point: it also hands over the
frame immediately before it, carrying a negative timestamp, and expects the
container to hide it with an edit list. A progressive MP4 does exactly that, which
is why the behaviour is invisible in ordinary use — but fragmented MP4 has no such
edit to apply, so that frame is delivered, and every epoch after the first began
one frame early. Concatenated, the title gained a frame per join and every epoch's
picture sat a frame later than its own timeline claimed.

Keyframes are still forced on time rather than on a frame count, and each epoch's
local timeline starts at zero, so the global two-second segment grid runs unbroken
through every join.

### The checkpoint layout

```text
<workRoot>/<mediaId>/
  <profileVersion>-<sourceFingerprint16>/     the durable build
    plan.json
    epochs/
      000000/                                 immutable: validated and manifested
        COMPLETE.json
        video/1080p/{media.m4s,playlist.m3u8}
        ...
      000001/
      000002.partial-<pid>-<token>/           being written; never read as done
        OWNER.json                            pid, host and heartbeat
    audio-stage/                              whole-title audio, own manifest
  <profileVersion>-<fingerprint>.<pid>-<id>.partial/   this attempt's staging
```

A directory named `000011` is a finished epoch. A directory named
`000011.partial-…` is work in progress that nothing may read. Nothing moves from
the second name to the first except an atomic rename performed _after_ the epoch
has been validated and its manifest written inside it, so a crash at any instant
leaves either a complete checkpoint or an obviously incomplete one — never
something that looks complete and is not.

`COMPLETE.json` carries the schema version, media id, source fingerprint, adaptive
profile version, timeline policy version, epoch index, exact start and end
presentation times, expected and measured duration, the encoder, and per rendition
the dimensions, codec, pixel format, HDR state, colour tags, frame rate, byte
size, segment count, media timescale and a digest of the initialisation segment.
A checkpoint is never reused because its directory exists: every one of those
identity fields is compared, and every file it names is checked for presence and
size.

### Assembly, which never re-encodes

Once every epoch is durable, the final renditions are built by **copying bytes**.
Each epoch was muxed with its own timeline starting at zero, which makes every
epoch's initialisation segment byte-identical — checked at assembly rather than
assumed — so one initialisation serves the whole title. Each fragment is then
moved onto the global timeline by adding one offset to its `tfdt` and to its
`sidx`, and the assembler holds one fragment back so the muxer's guess at the last
sample duration of each epoch can be corrected against the first decode time of
the next.

There is no decoder, no encoder and no remux. There is also no
`EXT-X-DISCONTINUITY` and no second `EXT-X-MAP`: what comes out is
indistinguishable from a single uninterrupted encode, which is why nothing in the
player had to change.

The `sidx` detail is worth stating because it was a silent failure. FFmpeg writes
a segment index in front of every fragment, and its
`earliest_presentation_time` is the second place a fragment records where it sits.
Leaving those at their epoch-local values produced a file whose frames were
perfectly correct and whose reported duration was that of its last epoch alone.

### Resume, retry and cancel

Every start reconciles the plan and the disk before any work begins:

| On disk                                                              | What happens                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Valid completed checkpoint                                           | Reused. Never re-encoded, never rewritten.                       |
| `.partial` owned by a live process                                   | Left alone.                                                      |
| `.partial` whose owner is gone or has stopped heartbeating           | Removed.                                                         |
| Completed directory whose manifest, identity or files do not hold up | That epoch alone is invalidated and rebuilt.                     |
| Plan whose source, profile, policy or epoch target differs           | The whole build is discarded, because the boundaries would move. |

Reconciliation is idempotent: running it twice does what running it once does.

**Cancel** stops the encoder and keeps every checkpoint. **Retry** reconciles and
continues from the first missing or invalid epoch — the interface says which,
rather than offering a bare "Retry" that reads as a threat to five hours of work.
**Resume** in the CLI means the same thing.

## Safe rollout

1. Analyse only. This probes the library and writes no media:

   ```text
   npm run media:renditions:analyse
   ```

   Review the adaptive coverage, shared-audio estimate, migration overhead and
   storage deferrals in the console and `rendition-analysis.json`.

2. Generate and validate one representative SDR title:

   ```text
   # Replace this sample with the exact path below SEYIRLIK_MEDIA_ROOT,
   # including the real filename and extension.
   npm run media:renditions:process -- --profile adaptive --source "Movies/Title (2026)/Title (2026).mkv" --dry-run
   npm run media:renditions:process -- --profile adaptive --source "Movies/Title (2026)/Title (2026).mkv"
   npm run media:renditions:validate -- --profile adaptive --source "Movies/Title (2026)/Title (2026).mkv"
   ```

3. Repeat for an HDR title, a 23.976 fps title, a variable-frame-rate title and a
   title whose default audio is AC-3/E-AC-3. Confirm colour, seeking, audio and
   quality changes in Chromium and WebKit/Safari.

4. Expand by library or stable media id. Resume is idempotent and reuses an
   already-valid version:

   ```text
   npm run media:renditions:resume -- --profile adaptive --library Movies --workers 1
   npm run media:renditions:status
   ```

5. Keep the old MP4 generation through the observation period. Seyirlik will use
   a valid adaptive package first, retain Original as a separate option, and fall
   back to complete files or the existing live planner when adaptive media is
   missing, stale, invalid or unsupported by the client.

`--profile all` runs legacy then adaptive processing deliberately. The default is
still `legacy`, so an existing automation cannot unexpectedly begin re-encoding
the whole library after deployment.

## Why existing renditions need a new video encode

The inspected library's completed MP4 renditions are H.264/AAC or HEVC/AAC and
their sampled keyframe timestamps align across qualities. Their GOP intervals are
about 10.24–10.72 seconds, however. They can be remuxed without quality loss only
into similarly coarse HLS segments. They cannot become independently decodable
two-second switching segments without inserting new video keyframes, and inserting
those keyframes requires video re-encoding.

Sources do not need to be replaced. MP4 + H.264/HEVC + AAC/AC-3/E-AC-3 inputs are
accepted: compatible AAC is stream-copied into shared audio; other audio is
transcoded to AAC. The required work is regeneration of the adaptive video ladder,
not reprocessing or deleting the source library.

## Playback and limitations

- Seyirlik's own policy (`src/lib/videoSource.ts`) chooses every rung wherever
  hls.js can run, Safari included via ManagedMediaSource. It answers through a
  subclass of hls.js's ABR controller, so the engine stays in automatic mode and
  a new rung joins at the next aligned fragment without flushing the buffer;
  hls.js keeps measuring throughput, abandoning late fragments and falling back
  after errors.
- The opening rung is chosen before any fragment is fetched, from what this
  browser last measured the same media origin delivering
  (`src/lib/throughputMemory.ts`): trusted as measured for 30 minutes, then
  discounted to 75% within a day and 50% within two weeks, and dropped when
  the browser reports a different kind of network. Without history it is
  5 Mbps (720p), or the browser's link hint when that is slower. The first two
  measured fragments may correct the opening rung at once; later climbs keep
  the two-second hold. Browser-cache reads and downloaded titles never teach it.
  `window.__seyirlikAbr()` shows the `opening-estimate` and every decision.
- Low Data caps ABR at the lowest rung; Higher Resolution permits the highest
  compatible rung; Advanced locks an exact rung.
- Original is not part of the switching set. Entering or leaving Original is a
  source transition and may briefly rebuffer.
- Safari's native HLS engine provides seamless ABR but does not expose its level
  selection API to JavaScript. Exact application-controlled locks are available
  where hls.js/MediaSource is used; native Safari may manage the level itself.
- HDR packages are offered only to clients that report HEVC/HDR capability.
- A requested audio track must exist in the adaptive package. Otherwise the
  normal playback planner falls back to complete-file or live processing.
- Embedded subtitles are not muxed into the adaptive video set. Text subtitles
  continue through the existing external subtitle path; image subtitles that
  require burn-in use live transcoding.

## Storage and cleanup

Adaptive estimates count video once per rung and audio once per selected track.
The migration estimate assumes legacy and adaptive generations coexist. Packaging
also preserves the prior adaptive version until the new one validates, so the
per-title free-space preflight includes temporary overlap and the configured
reserve. Bytes already protected by checkpoints are subtracted from that
preflight: a resumed job does not have to find room for work it has already done,
and reserving for it again is what stopped a nearly finished title from resuming
on a full-ish drive.

`cleanup` no longer sweeps by age. A work directory can hold fifty minutes of
validated, immutable encoding that a job is about to resume from, and "older than
twenty-four hours" describes precisely the job that was interrupted by a drive
being unplugged over a weekend. It now removes only what is provably unusable:

- partial epochs nobody is writing;
- staging directories from attempts that have ended;
- builds keyed to an obsolete profile version, or to media the analysis report no
  longer knows about;
- completed directories that carry no manifest, and so cannot prove what they
  hold.

**A valid completed checkpoint is never removed by this command, at any age.**
Completed published versions are not cleanup targets either, and neither are the
source files. Remove a specific obsolete version only after an observation period
and an explicit operator review.

## Migration

Published packages are unaffected. This change does not move
`ADAPTIVE_PROFILE_VERSION`, so every `.seyirlik` package already on disk stays
readable and playable, and nothing has to be re-encoded to keep serving.

Work in progress is another matter. Adaptive work directories written before this
change hold a half-finished package rather than epoch checkpoints: there is no
`plan.json`, no `epochs/` directory and no way to prove which part of the timeline
the bytes cover. Such a build is **not migrated**. The first run against that
title writes a plan, finds no checkpoints under it, and encodes from the
beginning; `cleanup` removes the leftovers as an obsolete build. That is a
deliberate choice — adopting bytes whose timeline cannot be proved is exactly the
failure the identity checks exist to prevent — and it costs one re-encode, once.

Database rows for interrupted jobs reconcile on the next start as they always
have: a job the database calls `running` with no living worker is parked as
waiting for storage and requeued, and the requeued attempt is the one that
discovers there is nothing to resume from.
