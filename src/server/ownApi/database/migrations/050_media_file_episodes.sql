-- The episodes a file holds, when it is more than the one it is filed under.
--
-- TMDB numbers some series per segment (SpongeBob's eleven-minute stories)
-- while the files are broadcast half-hours of two or three of them, and
-- releases number those files under three different schemes. A file row has
-- one item, the identity the scanner gives it from its name; a part here says
-- which episode really plays in it and where.
--
-- A file with no parts is what it always was: its own item, start to end. A
-- file with parts holds exactly those, and nothing else — so a half-hour filed
-- as S10E11 that actually holds 9x2 makes 9x2 available and 10x11 not.
--
-- Times are on the file's own timeline. Null when only the order is known (a
-- release named S01E01-E03): the episode is held, but where it starts is not.

CREATE TABLE media_file_episodes (
  media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  start_ms bigint,
  end_ms bigint,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_file_id, item_id),
  CONSTRAINT media_file_episodes_ordinal_unique UNIQUE (media_file_id, ordinal),
  CONSTRAINT media_file_episodes_ordinal_nonnegative CHECK (ordinal >= 0),
  CONSTRAINT media_file_episodes_times
    CHECK ((start_ms IS NULL OR start_ms >= 0)
      AND (end_ms IS NULL OR end_ms > COALESCE(start_ms, 0))),
  CONSTRAINT media_file_episodes_source_known
    CHECK (source IN ('release', 'detected', 'manual', 'survey'))
);

CREATE INDEX media_file_episodes_item_idx ON media_file_episodes (item_id);
