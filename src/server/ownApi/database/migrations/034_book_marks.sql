-- Each reader's bookmarks and highlights in each book, so the places and
-- sentences marked on one device are there on every other.
--
-- A row is one mark, named by the id the device that made it gave it. The
-- latest change to a mark wins, a removal included: a removed mark stays as a
-- row with no content, so a device that still holds it cannot bring it back.

CREATE TABLE user_book_marks (
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  mark_id text NOT NULL,
  -- The EPUB location kept: where the page began for a bookmark, the range it
  -- covers for a highlight. NULL once the mark is removed, as is all content.
  cfi text,
  label text,
  -- The text at a bookmark, or the text a highlight marks.
  excerpt text,
  -- How far through the whole book, 0 to 1.
  progress double precision,
  -- Set on a highlight only.
  color text,
  created_at timestamptz,
  removed boolean NOT NULL DEFAULT false,
  -- When the mark last changed, by the changing device's clock and never
  -- later than the server's. An older change than the stored one loses.
  changed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id, mark_id),
  CONSTRAINT user_book_marks_id_format
    CHECK (mark_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT user_book_marks_content
    CHECK (
      (removed AND cfi IS NULL AND label IS NULL AND excerpt IS NULL
        AND progress IS NULL AND color IS NULL AND created_at IS NULL)
      OR (NOT removed AND cfi IS NOT NULL AND label IS NOT NULL
        AND excerpt IS NOT NULL AND created_at IS NOT NULL)
    ),
  CONSTRAINT user_book_marks_cfi_length
    CHECK (cfi IS NULL OR length(cfi) BETWEEN 1 AND 4096),
  CONSTRAINT user_book_marks_label_length
    CHECK (label IS NULL OR length(label) <= 500),
  CONSTRAINT user_book_marks_excerpt_length
    CHECK (excerpt IS NULL OR length(excerpt) <= 10000),
  CONSTRAINT user_book_marks_progress_range
    CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  CONSTRAINT user_book_marks_color
    CHECK (color IS NULL OR color IN ('yellow', 'green', 'blue', 'pink', 'purple'))
);

CREATE INDEX user_book_marks_item_idx ON user_book_marks (item_id);
