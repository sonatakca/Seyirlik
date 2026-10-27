-- Putting a narration right without reading the book again: how words are to
-- be said, lines asked to be read again, and what the narrator heard in every
-- line, for an administrator to compare with the book.

-- Words the voice says wrong, and how to say them instead: "Sergievi" as
-- "sergi evi". One list for every book. `word` is the narrator's lookup key
-- (pronunciation_key in narrator/seyirlik_narrator/text.py): the word as
-- written, in Turkish lower case, without a suffix after an apostrophe.
CREATE TABLE narration_pronunciations (
  word text PRIMARY KEY,
  spoken text NOT NULL,
  created_by uuid REFERENCES native_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT narration_pronunciations_word
    CHECK (length(word) BETWEEN 1 AND 100 AND word !~ '\s' AND word = lower(word)),
  CONSTRAINT narration_pronunciations_spoken
    CHECK (length(spoken) BETWEEN 1 AND 200)
);

-- Lines (the narrator's chunks, "<section>-<block>-<index>") a person asked
-- to be read again. The count is part of what the narrator reads the line
-- as, so it only grows: a lower one would bring an older reading back.
CREATE TABLE book_narration_retakes (
  item_id uuid NOT NULL REFERENCES book_narrations(item_id) ON DELETE CASCADE,
  chunk text NOT NULL,
  count integer NOT NULL,
  requested_by uuid REFERENCES native_users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, chunk),
  CONSTRAINT book_narration_retakes_chunk
    CHECK (chunk ~ '^[0-9]{1,6}-[0-9]{1,7}-[0-9]{1,5}$'),
  CONSTRAINT book_narration_retakes_count CHECK (count > 0)
);

-- Asked to be read again while a narrator was reading it: it goes back to
-- the queue when that reading finishes, instead of being called ready.
ALTER TABLE book_narrations
  ADD COLUMN read_again boolean NOT NULL DEFAULT false;

-- Whether the narrator sent every line of this upload as it heard it
-- (<section>-<sha256>.check.json beside the audio). A new upload of the
-- section has not, until it does.
ALTER TABLE book_narration_sections
  ADD COLUMN checked boolean NOT NULL DEFAULT false;
