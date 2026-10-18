-- The live progress of a running encode, shared between machines.
--
-- Samples used to live only in a temporary file on the machine doing the
-- encode, which the API read back from the same disk. Once encodes moved to
-- a laptop the server could no longer see them, and the processing page fell
-- back to the video record for every later phase: audio, assembly,
-- verification and publishing all showed as video.
--
-- One row per running job, written at most once a second (and on every phase
-- change) by the worker, read by the API when it has no local sample. Rows go
-- with their job.

CREATE TABLE IF NOT EXISTS processing_live_progress (
  processing_job_id uuid PRIMARY KEY
    REFERENCES processing_jobs(id) ON DELETE CASCADE,
  -- The sample's own `timestampMs`; a write never replaces a newer sample.
  timestamp_ms bigint NOT NULL,
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
