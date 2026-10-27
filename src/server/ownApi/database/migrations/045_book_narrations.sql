-- Books read aloud. The narrator is a computer outside the server (the Mac
-- with the speech models), which takes a requested book, reads it section by
-- section and uploads each finished section here; the reader plays them.

-- The keys a narrator signs in with. A key is shown once, when it is made,
-- and only its SHA-256 is kept. It allows a narrator's work and nothing else.
CREATE TABLE narrator_keys (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  key_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- When the narrator last asked for work: whether it is there to read.
  last_seen_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT narrator_keys_label_length CHECK (length(label) BETWEEN 1 AND 100),
  CONSTRAINT narrator_keys_hash_length CHECK (length(key_hash) = 32)
);

-- One narration per book. Queued until a narrator takes it, narrating while
-- it reads (and keeps saying so), then ready or failed. A narration whose
-- narrator stopped saying so for long enough can be taken again.
CREATE TABLE book_narrations (
  item_id uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  state text NOT NULL,
  requested_by uuid REFERENCES native_users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- Set when a narrator takes it: the voice it reads in, and the version of
  -- the script it reads (narrationScript.ts), which names the blocks every
  -- word is timed in.
  voice text,
  script_version integer,
  narrator_key_id uuid REFERENCES narrator_keys(id) ON DELETE SET NULL,
  heartbeat_at timestamptz,
  -- The book's file as it was read: a narration of another edition of the
  -- book points at the wrong words.
  book_file_id uuid,
  book_fingerprint text,
  -- The narrator's latest report: how far, and what it is doing.
  progress jsonb,
  error text,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT book_narrations_state
    CHECK (state IN ('queued', 'narrating', 'ready', 'failed')),
  -- A book can fail before any narrator took it (it has no file), so only a
  -- narration being read or read through must say in what voice and script.
  CONSTRAINT book_narrations_claimed
    CHECK (
      state IN ('queued', 'failed')
      OR (voice IS NOT NULL AND script_version IS NOT NULL)
    ),
  CONSTRAINT book_narrations_narrating
    CHECK (state <> 'narrating' OR heartbeat_at IS NOT NULL),
  CONSTRAINT book_narrations_voice
    CHECK (voice IS NULL OR voice ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT book_narrations_error_length
    CHECK (error IS NULL OR length(error) <= 2000),
  CONSTRAINT book_narrations_progress_size
    CHECK (progress IS NULL OR pg_column_size(progress) <= 4096)
);

CREATE INDEX book_narrations_waiting_idx
  ON book_narrations (requested_at)
  WHERE state IN ('queued', 'narrating');

-- The sections uploaded so far. A row is written only once its audio and
-- word timings are both in place, under names that carry the audio's hash,
-- so a section replaced by a new upload is never half old and half new.
CREATE TABLE book_narration_sections (
  item_id uuid NOT NULL REFERENCES book_narrations(item_id) ON DELETE CASCADE,
  section integer NOT NULL,
  audio_sha256 text NOT NULL,
  audio_bytes bigint NOT NULL,
  duration_seconds double precision NOT NULL,
  word_count integer NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, section),
  CONSTRAINT book_narration_sections_section CHECK (section >= 0),
  CONSTRAINT book_narration_sections_sha CHECK (audio_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT book_narration_sections_bytes CHECK (audio_bytes > 0),
  CONSTRAINT book_narration_sections_duration CHECK (duration_seconds > 0),
  CONSTRAINT book_narration_sections_words CHECK (word_count >= 0)
);
