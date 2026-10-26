# Subtitle synchronisation engine

How Seyirlik moves an existing subtitle onto the edition being played —
region by region, from evidence, without changing a word of it — and what was
measured to decide how.

Everything here corrects **timing only**. A subtitle's text is read to decide
where its lines belong and is never translated, rewritten, or replaced.

## Why it changed

The previous aligner (`alignSpeech`) fitted one `rate · t + offset` to a whole
subtitle and wrote it when its confidence cleared 0.35. A subtitle timed to a
different cut of an episode has no single transform: right for twenty minutes,
eight seconds late after a scene the edition trimmed. The old path found the
late half's shift and wrote it over the right half.

Measured on nine packaged episodes (below), the old path **wrote a damaging
correction in 4–6 of 9 episodes per edit scenario**, moving 263–814 correct
cues each time, and shifted correct subtitles by 0.13–0.16 s because the energy
gate's onsets lag speech. It is kept only as the global rate search the new
engine starts from; nothing writes on its confidence any more.

## Components and data flow

```
                    ┌────────────────────── encoding laptop (heavy) ───────────────────────┐
 package audio ──▶  │ subtitle.analyse   ffmpeg → 16 kHz mono → whisper.cpp (CUDA/Metal/CPU)│
 (Drive mount)      │                    flags: sound captions, loops, stock lines, doubt  │
                    └───────────────┬──────────────────────────────────────────────────────┘
                                    │ subtitle_audio_analyses (PostgreSQL, keyed by audio)
                    ┌───────────────▼────────────────────── always-on server (light) ───────┐
 sidecar ──read──▶  │ subtitle.sync                                                         │
 (Drive mount)      │   references: reference subtitle, or audio → energy envelope (3 cuts) │
                    │   meaning:    cue text ⇄ transcript (LaBSE) → anchors (offset track)  │
                    │   alignPiecewise → regions, edits, unmatched/unresolved cues, verdict │
                    │   apply only if every cue is placed on strong evidence, else propose  │
                    │   writeSubtitleRevision: observe → pending → guarded rewrite → settle │
                    └───────────────┬───────────────────────────────────────────────────────┘
                                    │ subtitle_revisions (every version, with bytes)
                    sync panel: preview · regions · evidence · apply reviewed · versions · restore
```

| Module                                      | Responsibility                                                    |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `subtitles/piecewiseAlignment.ts`           | The piecewise engine: scores, split-penalty DP, regions, verdict. |
| `subtitles/subtitleTimeMap.ts`              | Applies placements to a document, untouched lines byte for byte.  |
| `subtitles/subtitleRevisions.ts`            | Version store and the recoverable write state machine.            |
| `subtitles/subtitleSync.ts`                 | The sync job: analyse, apply, apply reviewed, restore, compare.   |
| `subtitles/subtitleFit.ts`                  | Download-time best fit on the same engine.                        |
| `subtitles/subtitleTranscript.ts`           | whisper.cpp runner, parsing, hallucination and sound flags.       |
| `subtitles/subtitleSemantics.ts`            | Meaning-based anchors with local scaling and an offset track.     |
| `subtitles/subtitleEmbedder.ts`             | Multilingual embeddings through transformers.js (ONNX, CPU).      |
| `subtitles/subtitleAnalysis.ts`             | Configuration, audio identity, transcript cache, analyse job.     |
| `subtitles/subtitleVoice.ts`                | Silero voice segments (evaluated; see below).                     |
| `components/admin/SubtitleSyncProposal.tsx` | Region timeline, edits, evidence, apply choice.                   |
| `components/admin/SubtitleRevisionList.tsx` | Versions, compare, restore.                                       |
| `scripts/benchmark-subtitle-sync.ts`        | End-to-end benchmark with known truth.                            |
| `scripts/benchmark-subtitle-semantics.ts`   | Anchor precision per embedding model.                             |

## The piecewise engine

`alignPiecewise(cues, reference, { anchors })` models the subtitle as a sequence
of regions, each with its own `rate · t + offset`, found rather than assumed.

1. **Evidence above chance.** Every cue is scored at every offset (0.1 s grid,
   ±5 min by default) by how close its start lands to a reference onset and how
   much of it lands on speech, each minus what a randomly placed cue would get,
   plus any semantic anchor for that cue. A cue with no evidence scores about
   zero wherever it goes. Outside the stretch the reference covers, the
   reference says nothing for or against.
2. **One offset per cue, a penalty per change** (split-penalty dynamic
   programming, the `alass` family). A breakpoint must be paid for by the cues
   after it; one coincidental match cannot afford one. One program per
   candidate rate (1, the global aligner's, and a rate the anchors agree on when
   it is a real frame-rate transfer); a wrong rate drifts into a staircase of
   splits and loses.
3. **Each region on its own:** refined to the millisecond against the onsets it
   pairs with; trimmed to the core whose match rate beats a bar halfway between
   its own rate and chance; judged against the best rival offset anywhere in the
   search (not fixed decoys — the offset was chosen as the best of thousands);
   and compared with leaving it alone. A region about as good unmoved is
   _aligned_; a weak region is not a region.
4. **The gaps.** Between agreeing regions, cues move with them (_inferred_). At
   the document's own edges, a few minutes may follow the only neighbour.
   Between disagreeing regions the boundary is reopened (up to ten cues or 30 s
   each side) and split as left · absent · right: a cue may be _unmatched_
   (footage this edition lacks) only if it fits under neither timeline; cues on
   which near-best splits disagree stay _unresolved_ and unmoved.
5. **Verdict:** `in-sync` (nothing moves and at most 15% unverified),
   `correctable` (every cue placed), `partial`, `reordered`, or
   `insufficient-evidence`. `autoApplicable` additionally requires every
   corrected region at confidence ≥ 0.6, coverage ≥ 0.6, and no cue placed
   beside an edit by elimination.

Each reference kind has a measured profile (`PROFILES`): which edges count, how
far its onsets lag cue starts (energy gate 0.08 s, Silero 0.2 s), the smallest
shift worth proposing (0.15 s against a subtitle, 0.3 s against audio, below
which the "correction" is the detector's own scatter), and how much better one
placement of boundary cues must be before it is believed.

**Two confidences.** Anchor reliability lives in each anchor's weight (margin
over the best rival, times neighbour agreement). Regional reliability is the
region's strength above its best rival offset. They are not averaged into one
probability, and neither is shown to a person as one: the panel shows counts —
lines matched, lines moved, lines unverified.

## Audio evidence

**Energy envelope** (`audioSpeech.ts`, existing): FFmpeg band-passed RMS at
three duty cycles. Cheap (one pass over the package audio) and the baseline.

**Speech recognition** (`subtitleTranscript.ts`): whisper.cpp, run as a process.
No Python or service; one binary and one model per machine. Its built-in voice
detection is not used: whisper.cpp 1.9 leaves token times on its voice-only
timeline. Segments are flagged and excluded from evidence when they are sound
captions (kept separately as audio events), loops of the same line, stock
training-subtitle lines, low model confidence, or impossible speech rates.

**Meaning** (`subtitleSemantics.ts`): each cue's words (markup, speaker dashes
and sound descriptions removed) and each reliable transcript segment are
embedded; similarities are judged by cross-domain similarity local scaling so a
generic line that resembles everything stands out against nothing; one
candidate (or none) per cue is chosen along an offset track (half-second bins,
free to stay, a fixed cost to move), which matches a repeated line where its
neighbours are and follows an edit once the matches after it pay for it.

## Infrastructure

**Who runs what.** `subtitle.analyse` is a heavy job on its own lane at one at a
time, claimed only where `SEYIRLIK_SUBTITLE_ASR` is declared, never by a
release-handoff bridge (it would share the GPU with the old release's encode).
`subtitle.sync` and the download-time fit are light jobs on the always-on
server, which embeds with `SEYIRLIK_SUBTITLE_EMBEDDINGS` (model loaded on first
use, released after ten idle minutes). Only that server writes sidecars.

**Escalation.** A sync against audio that cannot place everything, for a title
never transcribed, queues a transcription and says so; the operator previews
again when it is done. Nothing waits on the laptop, and with it switched off the
job simply stays queued while syncing carries on from loudness alone.

**Google Drive.** The audio is the package's rendition, read through its
playlist (54–96 MB per episode for the nine benchmark episodes). The envelope
and the transcription each read it once; transcripts are cached in PostgreSQL
so no later sync, candidate, or review reads it for meaning again. Scratch
(16 kHz WAV) lives in a private temp directory removed on every exit path.

**Cache identity.** `audio_key` digests the media file, the source stream, the
audio stream, and the playlist's bytes (which name every byte range of the
rendition — a re-encode changes them) or, before packaging, the source's size
and mtime. Paths are excluded because the two machines mount Drive at different
places. `engine` names the recogniser and model (file name and size), and a
schema version invalidates transcripts when parsing changes.

## Versions and rollback

`subtitle_revisions` keeps every version of every sidecar this system touches,
bytes included (sidecars are ≤ 4 MiB; typically 20–80 kB): the `original` the
first time a path is touched, `external` when somebody changed the file since,
`download` and `fit` for a retimed download, `sync`, `manual`, `restore`. The
bytes live in the database, not beside the media, because a second file there
is a second track to the scanner, and Drive written from two mounts has lost
writes. `media_file_id` is nulled rather than cascaded when the catalogue
forgets a file.

A write (`writeSubtitleRevision`):

1. settles any pending write for the path by reading the file;
2. records the bytes the decision was made from (`observe`);
3. records the new bytes `pending` (at most one per path, by unique index);
4. writes through the existing guarded rewrite (same lock, digest check,
   validation, Windows recovery copies, read-back);
5. settles `committed` when the file reads back as the new bytes, `abandoned`
   otherwise; an ambiguous commit is settled by reading the file, or left
   pending for the next operation or the `subtitle.reconcile` sweep.

A crash at any point leaves either nothing pending or a row the file decides.
An install that replaces an owned subtitle preserves the replaced bytes first
or writes nothing. Restoring is itself a version, so history only grows.
Retention: everything is kept; it is small.

## Applying corrections

- **Sync** writes only when the result is `correctable`, `autoApplicable`,
  excludes nothing and pushes no line before the video starts. Anything else
  returns a proposal with reasons.
- **Preview** never writes.
- **Apply reviewed** names the preview task; the server reads that task's own
  placements and applies them to exactly the bytes it analysed (refused with
  `changed-since-analysis` otherwise). Lines from a missing scene are kept
  unless the operator chooses to leave them out of the active subtitle; the
  version they came from is kept either way.
- A moved line that now runs into the next is ended where the next begins when
  that leaves it readable; lines that already overlapped stay as they were.
  Untouched lines keep their timestamps to the millisecond.
- The player's subtitle refresh is requested after a commit, as before.

API: `GET/POST /subtitles/items/:itemId/sync` (POST takes `previewTaskId` and
`unmatched` to apply a reviewed proposal), `GET /subtitles/items/:itemId/sync/:taskId`,
`GET /subtitles/items/:itemId/revisions?streamIndex=`,
`GET /subtitles/items/:itemId/revisions/:revisionId/compare?streamIndex=`,
`POST /subtitles/items/:itemId/revisions/:revisionId/restore`.

## Evaluation

Everything below was measured on 25–26 October 2026 on a Mac (M1 Max) against
real packaged media copied from the production server. Nothing here is an
estimate unless it says so.

**Dataset.** Nine episodes of five series — Arcane S01E01/E03/E07/E08 (dense
score, songs, action), Andor S01E01/E07, House of the Dragon S01E05, Lilyhammer
S01E01 (English and Norwegian), Berlin S01E02 (Spanish audio): each package's
audio rendition (54–96 MB) and the Turkish WebVTT that was inside the release,
timed to that edition — the truth. English WebVTTs were present for eight.
No media is in the repository; `scripts/benchmark-subtitle-sync.ts` documents
the layout.

**Method.** Each Turkish truth was damaged and handed to each approach with the
episode's real audio; every cue's result was compared with its true time.
Scenarios: A second half 8 s late; B four regions (0, +4, 0, −12 s); C a
25/23.976 frame-rate transfer; D 45 s of lines from a scene this edition lacks;
E 40 s of footage only this edition has; F already right; plus a plain 6.5 s
shift. A cue left unmoved for review is measured where it was left, so an
approach cannot buy accuracy by refusing.

### Results (9 episodes, 95th-percentile error · cues within 0.5 s · correct cues damaged)

| Scenario        | Old global                             | Piecewise, loudness | Piecewise, loudness + meaning (LaBSE) | Piecewise, English subtitle |
| --------------- | -------------------------------------- | ------------------- | ------------------------------------- | --------------------------- |
| A half late     | 270.6 s · 47% · 424/2102, 4 bad writes | 8.0 s · 93% · 0     | 0.20 s · 99% · 0                      | 0.14 s · 100% · 0           |
| B four regions  | 170.9 s · 48% · 263/2113, 6 bad writes | 12.0 s · 78% · 0    | 0.29 s · 98% · 0                      | 0.13 s · 99% · 0            |
| C frame rate    | 94.8 s · 67%                           | 146.0 s · 84%       | 0.27 s · 99%                          | 112.2 s · 97% ¹             |
| D scene missing | 46.3 s · 59% · 725/1368, 5 bad writes  | 45.0 s · 91% · 2    | 0.17 s · 99% · 0                      | 0.09 s · 100% · 0           |
| E scene added   | 167.8 s · 42% · 814/1368, 5 bad writes | 40.0 s · 91% · 19   | 0.08 s · 99% · 2                      | 0.10 s · 100% · 0           |
| F already right | 0.16 s · 100% · 0 ²                    | 0.00 s · 100% · 0   | 0.00 s · 100% · 0                     | 0.00 s · 100% · 0           |
| plain +6.5 s    | 221.0 s · 67%, 1 bad write             | 6.5 s · 96%         | 0.24 s · 99%                          | 6.5 s · 98% ¹               |

¹ Lilyhammer's English subtitle covers only the Norwegian dialogue; the rest of
its lines stay unresolved and unmoved. ² The old path wrote a 0.13–0.16 s
"correction" into correct subtitles: the energy gate's onset lag.

"Bad writes" are corrections the approach would have written unattended that
moved a correct cue or left one more than 0.5 s off. **The piecewise engine made
none in any scenario, with any reference or model.** It wrote unattended in
21 of 56 runs against a subtitle reference and 11 of 63 against audio with
meaning; everything else came back as a proposal. Removed-scene lines found:
32 of 52 against a subtitle reference, 14 of 52 against audio with meaning,
with no real line reported as missing.

### What each component contributed (ablations)

| Component                                                     | Measured                                                                                                                         | Decision                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Piecewise model vs one transform                              | Above                                                                                                                            | Adopted                                             |
| Energy-gate onset lag                                         | 0.02–0.17 s per episode (median 0.08)                                                                                            | Compensated; 0.3 s floor for audio corrections      |
| Whisper small, word times                                     | Word start within 0.3 s of 65–90% of English cue starts                                                                          | Used for meaning, not timing                        |
| Whisper utterances as a timing reference                      | Moved 221 of 2209 correct cues in F; one bad unattended write                                                                    | Rejected                                            |
| Whisper built-in voice detection                              | Token times on its voice-only timeline (minutes off)                                                                             | Not used                                            |
| Meaning anchors: e5-small / e5-base / MiniLM / LaBSE / bge-m3 | Anchored cues 39 / 43 / 58 / 52 / 57%; precision 100 / 100 / 98 / 99.2 / 99.0%; repeated-line and half-late precision equal      | —                                                   |
| … end to end with loudness                                    | e5-small left whole regions unplaced (p95 12 s in B, 95 s in C); LaBSE and bge-m3 ≤ 0.29 s everywhere                            | LaBSE: equal to bge-m3 at a third of the time       |
| Silero voice detection                                        | 97–99% of what it marks is inside a subtitle line (energy gate 39–46%; Arcane 99% vs 25–36%); onsets lag 0.19–0.21 s             | `voice` reference kind; end-to-end comparison below |
| AST AudioSet tagging                                          | ~0.9 s per 10 s window on CPU (≈8 min an episode); as a hallucination guard on Arcane E01 it removed 1 false and 2 real segments | Rejected                                            |

<!-- VOICE-RESULTS -->

### Cost

| Step                                               | Measured                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Loudness envelope, one episode                     | Cached from earlier runs; the existing code's own note: ~20–30 s from a package over the Drive mount |
| Piecewise alignment, loudness (3 readings)         | 1.5 s median per subtitle (M1 Max)                                                                   |
| Piecewise alignment + meaning (embedding included) | 6.4 s median, 43 s max per subtitle (M1 Max, 8 threads)                                              |
| Whisper small, Metal                               | 91–149 s per 39–60 min episode (M1 Max)                                                              |
| Silero (whisper.cpp tool)                          | ~20 s per 41 min episode, 4 CPU threads                                                              |
| Transcript in PostgreSQL                           | ~100–200 kB per episode                                                                              |

**Not measured:** whisper.cpp on the MSI's RTX 4060 (CUDA build not installed
there); the embedding model on the Windows server's i5-9500T (expect several
times the Mac's 6 s); Drive bytes and read time on the current mounts beyond
package sizes; queue wait with the laptop off (the job waits indefinitely, by
design).

**Calibration.** Thresholds (split penalty, confidence, coverage, onset lags,
negligible shifts, anchor margins) were set from these nine episodes with
synthetic damage, not from human-labelled real mis-syncs. The confidence figure
is a strength above the best rival offset, not a probability, and the UI shows
counts instead. A labelled set of genuinely mis-synced downloads is the missing
piece before trusting unattended writes beyond subtitle references.

## Deployment

1. Apply migrations 043 and 044 before or with the code (the services refuse to
   start on a database behind them): `scripts/run-own-api-migrations.ts` as the
   app role, from an LF checkout.
2. Server: `SEYIRLIK_SUBTITLE_EMBEDDINGS={"modelDir":"C:\\ProgramData\\Seyirlik\\generated\\models","threads":2}`.
   LaBSE (463 MB) downloads on first use and is released after ten idle
   minutes; its memory on the server has not been measured.
3. MSI: a CUDA build of whisper.cpp (`whisper-cli.exe`) and a ggml model
   (`ggml-small.bin`, 488 MB, multilingual; `large-v3-turbo` is a later
   upgrade), then `SEYIRLIK_SUBTITLE_ASR={"binaryPath":"…\\whisper-cli.exe","modelPath":"…\\ggml-small.bin","threads":8}`.
   Only a host with this set claims `subtitle.analyse`; one at a time.
4. Neither variable is required: without them syncing uses loudness and
   reference subtitles, and transcription jobs wait in the queue.

## Limitations

- Long music-only or singing stretches have no speech to time against; their
  lines follow agreeing neighbours or stay unresolved.
- A few cues beside an edit may be unplaceable; they stay unmoved.
- A scene moved elsewhere in the episode is reported as reordered, not fixed.
- Translations that merge or skip many lines give fewer meaning anchors.
- Lines spoken in a language other than the transcription language (Lilyhammer)
  give weak anchors.
- Unattended writes against audio are deliberately rare (11 of 63 runs); most
  audio results are proposals for review.
- Offline copies saved on devices were not examined: whether they pick up a
  resynced subtitle is unverified.
