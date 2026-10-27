-- What the speech recogniser made of a title's audio, kept for every subtitle
-- that will ever be timed against it.
--
-- Transcribing an episode costs minutes of a GPU on the encoding laptop; every
-- subtitle candidate, every re-sync and every review afterwards reuses it. The
-- laptop writes the row and the always-on server reads it, which is why it is
-- here rather than in a file: both share this database, and neither can see the
-- other's scratch directory or mount cache.
--
-- `audio_key` identifies the audio itself, not the title: a digest of the media
-- file, the source stream and the content of the audio rendition's playlist
-- (or the source's size and modification time before it is packaged). A
-- re-encoded package has a different playlist and therefore a different key, so
-- a transcript of old audio is never used for new audio. `engine` names the
-- recogniser and its model, so an upgraded model writes a row of its own.
--
-- Derived data: recomputable, so it goes with the media file.

CREATE TABLE IF NOT EXISTS subtitle_audio_analyses (
  id uuid PRIMARY KEY,
  media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  source_stream_index integer,
  audio_key char(64) NOT NULL,
  kind text NOT NULL,
  engine text NOT NULL,
  schema_version integer NOT NULL,
  result jsonb NOT NULL,
  produced_by text,
  elapsed_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subtitle_audio_analyses_kind_known CHECK (kind IN ('transcript'))
);

CREATE UNIQUE INDEX IF NOT EXISTS subtitle_audio_analyses_identity
  ON subtitle_audio_analyses (audio_key, kind, engine, schema_version);

CREATE INDEX IF NOT EXISTS subtitle_audio_analyses_media
  ON subtitle_audio_analyses (media_file_id, created_at DESC);
