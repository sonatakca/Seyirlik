-- Every version of a subtitle sidecar this system has seen or written.
--
-- Retiming rewrites a subtitle in place, and until now the only copy of what
-- it replaced was a Windows-only recovery folder with no record pointing at
-- it. A subtitle is somebody's translation; its original bytes are not ours to
-- lose. Each row here holds one version's complete bytes, so any of them can
-- be restored, compared or audited without the file it came from.
--
-- The bytes live in the database rather than beside the media. A second file
-- beside a video is a second subtitle track to the scanner and to the player,
-- and the media volume is a Google Drive mount written by two machines, which
-- has already lost writes. Both machines share this database; a sidecar is a
-- few tens of kilobytes and never more than MAX_SUBTITLE_BYTES (4 MiB).
--
-- `origin`:
--   original  the bytes on disk the first time this system touched the path
--   external  bytes somebody else put there since (a hand edit, a copy)
--   download  a provider's bytes before they were retimed for installation
--   fit       those bytes as installed after a download-time retiming
--   sync      a retiming by the sync job
--   manual    a correction typed by an operator
--   restore   an earlier revision put back
--
-- `state` makes a write recoverable: a revision is `pending` before its bytes
-- are written to the sidecar, and settles as `committed` once the file is read
-- back with exactly those bytes, or `abandoned` when it is not. A crash in
-- between leaves the pending row, and the next operation on that path settles
-- it by reading the file. At most one pending revision per path.
--
-- `media_file_id` is nulled, not cascaded, when the catalogue forgets a file:
-- a rescan can delete a row while the subtitle's history is still somebody's
-- only copy of their original. The path stays, so the history is still found.

CREATE TABLE IF NOT EXISTS subtitle_revisions (
  id uuid PRIMARY KEY,
  media_file_id uuid REFERENCES media_files(id) ON DELETE SET NULL,
  relative_path text NOT NULL,
  revision integer NOT NULL,
  origin text NOT NULL,
  state text NOT NULL,
  sha256 char(64) NOT NULL,
  size_bytes integer NOT NULL,
  content bytea NOT NULL,
  parent_id uuid REFERENCES subtitle_revisions(id) ON DELETE SET NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,

  CONSTRAINT subtitle_revisions_origin_known
    CHECK (origin IN ('original', 'external', 'download', 'fit', 'sync', 'manual', 'restore')),
  CONSTRAINT subtitle_revisions_state_known
    CHECK (state IN ('pending', 'committed', 'abandoned')),
  CONSTRAINT subtitle_revisions_positive CHECK (revision > 0),
  CONSTRAINT subtitle_revisions_size_matches CHECK (octet_length(content) = size_bytes)
);

CREATE UNIQUE INDEX IF NOT EXISTS subtitle_revisions_number
  ON subtitle_revisions (media_file_id, relative_path, revision);

CREATE UNIQUE INDEX IF NOT EXISTS subtitle_revisions_one_pending
  ON subtitle_revisions (media_file_id, relative_path)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS subtitle_revisions_path
  ON subtitle_revisions (relative_path, revision DESC);
