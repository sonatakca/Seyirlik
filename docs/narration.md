# Books read aloud

Seyirlik can read a book aloud: a narrator voice reads it, the reader plays
it with the spoken words lit on the page, and a tap on a word plays from
there. This page covers how it is made and kept. The reader's side is in
`src/pages/reader/readAlong.ts`.

## How it fits together

The speech models (Higgs Audio for the voice, MMS for word timings) run on
the Mac with Apple Silicon (MLX). They need about 11 GB, more than the
server or the MSI laptop has. The Mac is not a Seyirlik worker: it has no
database and no media volume, and a laptop that sleeps must not hold the
server up. It is a **narrator**. It asks the server for work over HTTPS,
reads a book locally, and uploads each finished section.

```
administrator ── "Bu kitabı seslendir" (reader, ··· menu) ──▶ server: book_narrations, queued
narrator (Mac) ── POST /narrator/claim ──▶ server: narrating, held by this key
               ── GET  /narrator/jobs/:id/script        the book's blocks, as the reader counts them
               ── POST /narrator/jobs/:id/progress      every minute, and as it reads
               ── PUT  /narrator/jobs/:id/sections/:n/audio?offset=   16 MiB parts
               ── POST /narrator/jobs/:id/sections/:n   hash + word timings: the section goes live
               ── PUT  /narrator/jobs/:id/sections/:n/check   every line as Whisper heard it
               ── POST /narrator/jobs/:id/finish        ready, or failed and why
reader ── GET /books/:id/narration[/sections/:n/words|audio]
```

Sections can be played as they arrive; the reader looks again every 20 s
while a narration is on its way.

## Rules worth knowing

- **One narrator key per Mac.** A key is `snk_` and 256 random bits. The
  server keeps only its SHA-256. A key opens the `/narrator/*` routes and
  nothing else, and a person's session opens none of them. Those routes need
  no origin or CSRF token, because a browser never sends an `Authorization`
  header on its own.
- **Holding a book.** Only the narrator that took a book may report on it or
  upload to it. If it says nothing for 15 minutes, another narrator may take
  the book. The first one then gets `NARRATION_NOT_HELD` and stops.
- **A section goes live whole or not at all.** Audio and words are stored as
  `<section>-<sha256>.m4a` and `.words.json` under
  `<generated>/narrations/<itemId>/`. The database names the hash it serves,
  so a re-uploaded section switches in one row change, and the old files go
  afterwards.
- **Uploads are checked.** The audio must match the hash the narrator sent
  and be an MP4. Every word must lie in a block of that section, inside the
  block's text, within the audio, and in order.
- **Outdated narrations.** A narration belongs to one voice, one script
  version (`NARRATION_SCRIPT_VERSION`) and one edition of the book (its
  file's fingerprint). If the book's file changes, the narration shows as
  outdated and is not played. A narration taken again in another voice or
  from another script drops the sections it had.

## Putting a narration right

Every take is judged before it is kept: Whisper's hearing of it against the
book (skipped words), the aligner's score of each word (garbled ones), its
length, and its **tone**. A take is cried out when Whisper hears a `!` the
book does not have, or its last words are 8 dB or more louder than its middle
word where the last sentence has no `!` (`LOUD_END` in `verify.py`). A take
that fails any check is made again, up to three times, and the best kept; the
calmer one wins between equals. When the checks grow (`CHECKS` in
`narrate.py`), lines finished before are judged again from their takes the
next time their book is read, and read again only if none passes.

What no check catches is for a person, at **Seslendirme denetimi**
(`/admin/narration`, or _Seslendirmeyi denetle_ in the reader's ··· menu).
It lists every line beside what Whisper heard, word for word, worst first:
the narrator's own doubts, then words heard furthest from the book. How
Whisper writes is not a difference (circumflexes, numbers as digits, "ile"
joined on, its "Altyazı M.K." on silence). Two fixes, both picked up within
the narrator's minute of polling:

- **A pronunciation**: a word and how to say it ("Sergievi" → "sergi evi").
  It holds for every book. The voice is given the spoken form, the words are
  still timed at the book's own, and the books that have the word go back to
  the narrator, which reads again only the lines with it. Taking one off
  brings the old takes back without reading anything.
- **Read again**: one line, made afresh. The times a line was asked for are
  part of what it is read as, so the count only grows.

A narration given back is queued again with its sections, which go on
playing; one being read when asked goes back to the queue when it finishes
(`read_again`). The narrator reads each section only for what changed, loads
the models only if a line must be made, and uploads only sections whose
recording changed.

## Setting it up

Apply migrations `045_book_narrations.sql` and `046_narration_review.sql`
**before** shipping code that has them. The services refuse to start on a database that lacks it (see
`windows-deployment.md`).

1. Make a key, on the server, where its settings are:

   ```
   node --env-file=<settings.env> --env-file=<secrets.env> --import tsx scripts/narrator-key.ts create "MacBook Pro"
   ```

   It prints the key once. `list` shows each key and when it was last seen;
   `revoke <id>` locks one out.

2. Connect the Mac. Use the narrator's environment (Python 3.12,
   `narrator/requirements.txt`) from a checkout that stays where it is:

   ```
   cd narrator
   python -m seyirlik_narrator.service connect --server https://playback.seyirlik.org
   python -m seyirlik_narrator.service install
   ```

   `connect` asks for the key and keeps it in the login keychain
   (`org.seyirlik.narrator`). `install` adds a launch agent that starts at
   login and stays running. The voice is taken from
   `~/Library/Application Support/Seyirlik Narrator/voices/<voice>`; it is
   `mk` unless `connect --voice` says otherwise. Voices are never committed:
   the repository is public.

3. In the reader, an administrator's ··· menu now shows _Sesli kitap_:
   whether a narrator is connected, a button to narrate the book, and its
   progress once it has started.

## Running it

- `python -m seyirlik_narrator.service status` shows the server, the key,
  whether the agent is running, and the last book with how far it got.
- The log is `~/Library/Application Support/Seyirlik Narrator/logs/service.log`.
- Everything read is kept in `…/Seyirlik Narrator/work/<itemId>/`, so a
  stop at any moment loses nothing: the narrator takes the same book back
  and goes on. Delete a book's folder there to make it read again from
  scratch.
- While reading, the narrator keeps the Mac awake (`caffeinate -i`), but a
  closed lid still sleeps unless the Mac is on power with a display
  attached. An idle narrator ends after ten minutes to give the models'
  memory back, and launchd starts it again without them.
- Audio is AAC at 64 kbit/s, about 30 MB an hour, in generated storage on
  the server.

## Not done yet

The user manual comes next.
