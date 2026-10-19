# Subtitles

Seyirlik finds, judges, downloads and installs subtitles itself. This is what
the subsystem guarantees, what it deliberately does not do, and how to turn it
on.

It exists to replace the application-level job Bazarr was doing. **Bazarr is not
a runtime dependency and must not become one.** Nothing here calls it, reads its
database, or requires it to be running. It is a thing that can be switched off
once this subsystem has been exercised against real media.

## Source sidecars and packaged subtitles

An installed or hand-added SRT stays beside the source video. Adaptive processing
converts retained subtitles to `subtitle/turkish.vtt` (with numbered names for
additional tracks), writes the playlists under `.seyirlik/subtitle/`, and adds
them to the master playlist. The source SRT is preserved.
These paths are relative to the active package root. Incremental repairs can
publish under `.seyirlik-generations/`; `.seyirlik/current.json` selects the
active generation, so its subtitles need not appear in the original root folder.

Discovery accepts language tags separated by dots, hyphens, underscores or
spaces, including `LAMA-tr-synced.srt` and `.tur.srt`. Release words such as
`HDR` or `The` are not languages. English and Turkish are retained by default.

Adding a subtitle after a package was published does not itself run adaptive
processing. Process the title again from the admin page, or run the following
from the server checkout with its configured media root:

```powershell
npm run media:renditions:process -- --profile adaptive --source "Movies/The Wolf of Wall Street (2013)/The.Wolf.of.Wall.Street.2013.2160p.UHD.BluRay.x265.10bit.HDR.DDP5.1-LAMA.mkv"
```

Analysis detects new or changed sidecars even when the video ladder is complete.
Processing refreshes subtitles while reusing intact video and audio. Sidecar
reuse checks a fingerprint of both filename and bytes, so inserting an earlier
filename cannot reuse another subtitle's synthetic stream index. Packages made
before these fingerprints were recorded refresh their retained sidecars once.

## Switched off unless configured

There is one environment variable, `SEYIRLIK_SUBTITLES`, holding JSON:

```json
{
  "libraryRoot": "/absolute/path",
  "providerIds": ["example"],
  "timeoutMs": 30000
}
```

Absent or empty, the subsystem does not exist: no runtime is constructed, no
query is issued, no route is mounted, and the worker's library lane is told to
exclude the three subtitle job types so it never leases work it cannot handle.
A server that has never heard of subtitles behaves exactly as it did before.

The declaration is refused rather than partially understood. An unknown key, a
relative `libraryRoot`, a provider id that is not a plain slug, a duplicate
provider id, or a `timeoutMs` that is not a whole number of milliseconds
between 1 and 300000 all fail the parse. An absent `timeoutMs` defaults to
30 seconds; an explicit `null` does not, because a null where a number belongs
is a mistake rather than a way of saying "unset".

**Secrets are not configuration fields.** There is no cookie, token or password
in this block, and the parser rejects any key it does not know, so one cannot be
smuggled in.

## What a client can ask for

Three administrator-only routes. A client names a catalogue id and a policy —
never a path, a provider URL, or a destination.

| Route                               | What it does                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /subtitles`                   | Records a want and queues a search. Body: `mediaFileId`, `language`, and optionally `forced`, `hearingImpaired`, `replace`. |
| `GET /subtitles/:attemptId`         | State, the provider being waited on, and the failure class. Nothing else.                                                   |
| `POST /subtitles/:attemptId/resume` | Continues an attempt that is waiting for a person to sign in. Refused in any other state.                                   |

The language is normalised to ISO 639-2 at the edge, so `tr`, `TR-tr` and `tur`
are one want, and a sidecar is named `.tur.srt`. A language nothing speaks is
refused rather than searched for.

`failureDetail` never leaves the server. It can carry a provider's own words,
and a provider's words are untrusted text.

## What it will and will not write

The full rules are in [library-file-ownership.md](library-file-ownership.md).
The short version:

- The destination is derived from the media file the catalogue id resolves to.
  No provider, payload, or API client chooses where a byte lands.
- Everything stays inside the configured root, checked after path resolution
  rather than before it, and a symbolic link _below_ the root on the way to a
  file is refused.
- A new file goes in with a no-clobber `link`, so two workers racing produce one
  file and one loser, never a torn one.
- A subtitle is replaced only when `subtitle_installations` holds a row for that
  exact path **and** the recorded digest still matches the bytes on disk.
  `replace` is permission to upgrade Seyirlik's own work, never permission to
  take somebody else's.
- Byte-identical content is a `duplicate`: it satisfies the want, it is not a
  write, and it does not confer ownership.

### A title whose source has been removed

A processed title can lose its source ("Remove source", or the Drive
auto-delete once its package is verified) and keep playing from its package.
Its catalogue row stays active on purpose, and a sidecar beside where the source
was is served on its own. So search, install, upload and retiming all work for
it. The writer needs the **folder** the source lived in, not the source file:

- Every folder on the way must exist, and none may be a link. At the source's
  own name there may be nothing, or a regular file. Anything else is refused.
  Containment and the same-directory rule for sidecars are unchanged.
- The sidecar is named after the catalogue path, so it lands exactly where it
  would have with the source present.
- Sidecars beside an absent source are matched **by name**. Once a season's
  sources are gone its `src/` folder holds sidecars and no video. Counting
  videos would treat that as one film's folder and give each episode every
  episode's translation, and would call the want already satisfied. The cost:
  a hand-added movie subtitle named after a different release is not counted
  for a removed source, so a search can add a second Turkish track beside it.
- The install records the sidecar in `media_streams` at once, through the same
  `attachExternalSubtitle` the upload uses (event `catalogue-attached`). This is
  required, not a convenience. The scan reads a rendition-backed title from its
  package and never rewrites its sidecar rows, so without this the subtitle is
  never listed.
- Retiming works against every kind of reference. An audio track is read from
  the package's rendition of that track, and a subtitle that was inside the
  video from the package's WebVTT copy (`TitleReferences`). Only a track the
  package never kept, such as an image subtitle, is refused as
  `source-removed`. The package is preferred even while the source exists:
  it is the same print, and much less to read over the Drive mount.

Remove Source therefore does not wait for open subtitle wants: removing the
source does not stop them being answered.

A known consequence: **a subtitle that arrived with a download cannot currently
be upgraded by this subsystem**, because the importer records no digest for it.
Closing that is a change to the import pipeline, and is recorded there rather
than worked around here.

### Choosing the candidate that fits

The scorer ranks candidates by what providers say: identity, frame rate,
release group. That metadata often cannot decide. TürkçeAltyazı carries The
Sopranos S01 as one translation timed four ways, and nothing on the site tells
which timing matches this file. So a search downloads up to five valid
candidates (`fitCandidates`). It measures each against the title's own audio
with the same `alignSpeech` that retiming uses, and installs the best fit:

- The references are the package's: its default audio rendition, read through
  its playlist (about twenty seconds over the Drive mount), and its WebVTT
  copies of any text subtitles that were inside the video. A packaged sidecar
  is not a reference, because nothing says it was timed for this video. A
  title not packaged yet uses the source's default audio track instead.
  `confidence` compares across audio and subtitle references, so the best of
  them decides. They are read once per search; each further candidate is
  arithmetic.
- A fit at or above `MINIMUM_SYNC_CONFIDENCE` that is measurably off (offset
  over 0.15 s, or any rate change) is moved onto the audio before it is written.
  The installation is then recorded `assumed-in-sync`.
- Byte-identical downloads are measured once. The checkpoint names the
  candidate that was installed, so a resumed attempt downloads that one.
- With no audio to read, or once reading it fails, the first valid download
  wins, ranked by metadata alone. The audio never becomes the reason a search
  fails.
- The `installed` event carries `fitMeasured`, `fitConfidence`, `fitRate`,
  `fitOffsetSeconds` and `fitRetimed`.

On S01 measured by hand, the pick this makes is pack 375975 for E01–E04, and
pack 320688 for E06. UNIT3D's E06 drifts to a second late by the end.

A short HTML answer to a download (TürkçeAltyazı's `İlginç hatalar oluştu!`)
is that one file failing, not the session expiring. It no longer parks the
attempt in `needs-authentication` while other candidates could answer it.

## The states an attempt can be in

`wanted → searching → selected → downloading → validating → installed`, with
`superseded`, `unavailable` and `failed` as the other terminal answers, and
`needs-authentication` as the one state that is neither finished nor failed.

Two of these matter more than the rest:

**`needs-authentication` is a pause, not a failure.** A provider that wants a
person to prove something has not errored; it is waiting. The job returns that
state rather than throwing, so no retry is spent, the attempt is not marked
failed, and a human response time does not become a retry storm against a site
that already suspects us. The stage reached is checkpointed, and the resume job
re-enters the same implementation with that stage remembered — one code path and
a flag, not a second handler free to drift from the first.

On a deployment with no interactive session host wired in, every session-based
provider answers `needs-authentication` immediately. That is the correct answer
for a headless server: wiring a host in later resumes the work rather than
requiring it to be started again.

**`validating` means bytes may be on the disk that nothing has recorded.** It is
the state a crash between the write and the commit leaves behind. The
`subtitle.reconcile` job walks these: if the file at the derived path matches the
receipt — digest _and_ inode — the installation is recorded and the attempt
finishes without downloading anything again. If it does not match, the attempt
stays in `validating` and raises an `operator-attention` event, because guessing
is worse than asking.

## The three jobs

| Type                   | What it is for                                     |
| ---------------------- | -------------------------------------------------- |
| `subtitle.run`         | One attempt, start to finish.                      |
| `subtitle.auth-resume` | The same work, continued after somebody signed in. |
| `subtitle.reconcile`   | Sweeps attempts a crash could have left uncertain. |

They run on the existing leased queue. A task naming no attempt, or an attempt
that no longer exists, is refused permanently rather than retried — no amount of
retrying makes it valid. A media file another worker is already holding produces
a deferral, not a failure.

One PostgreSQL advisory lock per **media file** serialises every want for that
file across every worker, so two subtitles for one film are never written at the
same moment.

## Session material

A provider session lives in a closure, not on a property. There is no field for
a spread, a serialiser or a debugger snapshot to reach, and `toJSON` and
`toString` are overridden to return `[provider session withheld]` — overridden
rather than merely absent, because a structured logger reaches for `toJSON`
first.

Nothing a job returns, records as an event, or writes to the database carries
it. Migration 024 stores normalised candidate facts and a filesystem receipt;
neither has anywhere to put a cookie, and the checkpoint copies only the fields
the provider contract declares rather than whatever an adapter happened to
attach.

What is **not** implemented, on purpose: there is no Cloudflare bypass, no
CAPTCHA solving, no fingerprint or stealth evasion, no embedded browser, and no
hard-coded cookie.

## TürkçeAltyazı and signing in

`turkceAltyaziProvider.ts` is the one registered provider (`turkcealtyazi`,
Turkish and English). It finds a title by the catalogue's IMDb id — the site's
`/mov/<n>/` id _is_ the IMDb number — or, without one, by name and year from
the site's search. It reads the title page's subtitle list, fetches the detail
pages of the five likeliest rows for their full release names, and downloads by
posting the page's own form to `/ind`. Season packs are unpacked and the
episode's file chosen by name (`S01E02`, `1x02`, or a bare `E02` inside a
season's pack). ZIP only: RAR and 7z are refused so the next candidate is
tried. Turkish text that is not UTF-8 is decoded as Windows-1254, which is what
the site's uploads are.

"Best fitting" is the scorer in `subtitleSelection.ts`, now with **frame rate**
as a dimension (a 25 fps subtitle drifts a minute over a 23.976 fps film) and
the provider's download count as the first tie-break. The query carries the
release the file was imported from (`import_files.source_relative`), falling
back to the file's own name.

The site usually answers anonymous requests, so it is asked anonymously, under
an honest `Seyirlik/1.0` user agent, until Cloudflare answers with a challenge
(`cf-mitigated: challenge`, or the interstitial on a 403/503). That is
`needs-authentication`, and the session is marked **rejected**. A person then:

1. opens turkcealtyazi.org in their own browser, passes the check and signs in;
2. copies the `Cookie` request header from the browser's developer tools;
3. pastes it under **Integrations → Subtitle provider sign-in**. The page fills
   in that browser's user agent, because the cookie is only honoured from the
   browser that earned it (and, in practice, from the same public IP — sign in
   from the home network the server is on).

Saving resumes every attempt waiting for that provider.

**Where it is kept.** Migration 027 adds `provider_sessions`. The cookie and
user agent are sealed with AES-256-GCM under a key derived (HKDF) from
`SEYIRLIK_SESSION_HASH_SECRET`, with the provider id as associated data. The
database never holds the material in the clear, and the routes never return it —
`GET /subtitles/providers` reports only the state (`anonymous`, `active`,
`rejected`, `signed-out`). A refusal of an older session cannot wipe one pasted
after it: invalidation only applies to the row version that process handed out.
Rotating the session-hash secret makes a stored session unreadable, which reads
as "needs a sign-in" rather than an error.

| Route                                     | What it does                                                  |
| ----------------------------------------- | ------------------------------------------------------------- |
| `GET /subtitles/providers`                | Configured providers and each one's session state.            |
| `PUT /subtitles/providers/:id/session`    | Body `cookie`, `userAgent`. Sealed; waiting attempts resumed. |
| `DELETE /subtitles/providers/:id/session` | Forget it; the provider is asked anonymously again.           |
| `POST /subtitles/items/:itemId`           | Wants a language for a film, or every episode file of a show. |
| `POST /subtitles/items/:itemId/upload`    | Files a subtitle the operator already has. See below.         |

## Uploading one by hand

Finding a subtitle is slow, uncertain and worth retrying, which is what the want,
the attempt and the state machine are for. A file somebody already has is none of
those things: they know the title and the language and they want an answer now.
So `POST /subtitles/items/:itemId/upload` is a plain request-scoped operation —
no want, no attempt, no queue — and it answers with where the file went.

The bytes are the request body; the policy is the query
(`language`, `forced`, `hearingImpaired`, `replace`). Nothing about the file's
own name is read. The item must resolve to exactly **one** media file, so a film
or one episode: a show is refused rather than having the subtitle filed against
whichever episode sorted first.

What is unchanged is the writing. It goes through `subtitleStorage.install`, so
the destination is derived from the media file, containment is checked after
resolution, a link on the way down is refused, a new file goes in with a
no-clobber `link`, and a subtitle this system did not install is never replaced
whatever `replace` says. `[YTS] dune.2021.tr.srt` therefore arrives as
`Dune (2021).tur.srt`.

Two things differ from a downloaded subtitle, both deliberate:

- **Windows-1254 is accepted.** The payload validator takes UTF-8 only and must
  not guess, which is right for a provider's bytes and wrong for a person's own
  file — Turkish subtitles in the wild are overwhelmingly CP1254. The route
  applies `toUtf8` first, and the language the operator chose is what makes that
  a decision rather than a guess. ASS is still refused: installing one means
  owning its styling, fonts and script directives.
- **The sidecar is recorded against the media file at once**, through
  `attachExternalSubtitle`. The player's track list is built from
  `media_streams`, and only a library scan writes external rows — so without
  this the file would be correctly named, correctly placed and invisible until
  the next scan. Failing to attach does not fail the upload; the scan still
  picks it up.

Only Turkish and English are accepted, because those are the only languages the
player offers. Filing a third correctly and then never showing it is a worse
answer than a refusal that says so.

## How far it has been proven

`subtitleWorkflow.e2e.test.ts` runs twenty-nine scenarios against a real
temporary library: real handlers, service, state machine, pipeline, scorer,
payload validator and storage writer, with files written to a disk and read back
from it.

Two things are substituted there, and both matter when reading a green suite:

- **The providers are scripted.** A test that reached a real subtitle site would
  test that site's availability and spend somebody else's rate limit.
- **The execution repository is synthetic.** The real one is PostgreSQL — an
  advisory lock, a checkpoint `UPDATE`, an event `INSERT`. The fake honours the
  same contract, so the service's _use_ of it is covered, but **the SQL in
  `subtitleExecution.ts` and migrations 023–024 have not been run against a real
  database**, and must be before this subsystem is trusted in production.

Nor has any of it run against real media. That waits on the storage phase.

## Before switching it on

1. Apply migrations 023 and 024 — **before or with the code, never after it**.

   Migrations are validated at startup, not applied at startup. `nativeRuntime`
   and the identity runtime both call `validateMigrationsCurrent`, which
   compares every file in `migrations/` against the `seyirlik_migrations` table
   by version _and_ checksum, and throws when they disagree. Deploying a
   checkout that contains 023 and 024 to a host whose database has neither will
   stop the server and the worker from starting at all — not just the subtitle
   subsystem, and not just when it is configured. It is a deployment ordering
   hazard rather than a subtitle one, and it is why this is the first step.

   ```
   npm run db:migrate
   ```

   The role that runs it needs DDL rights on the schema; the application role
   does not need to be that role.

2. Run the execution repository against a real database.
3. Point `libraryRoot` at a synthetic directory first, not at the library.
4. Name the provider: `"providerIds": ["turkcealtyazi"]`. A configured
   provider id with no registered adapter is refused at startup rather than
   discovered at run time.
5. Apply migration 027 with the code that uses it.
