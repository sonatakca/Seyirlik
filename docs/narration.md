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

## Setting it up

Apply migration `045_book_narrations.sql` **before** shipping code that has
it. The services refuse to start on a database that lacks it (see
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

3. In the reader, an administrator's ··· menu now shows *Sesli kitap*:
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

A screen to review the words the narrator was unsure of and read them again,
a pronunciation list, and the user manual come next.
