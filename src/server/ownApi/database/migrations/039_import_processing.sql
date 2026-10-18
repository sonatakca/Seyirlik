-- Whether an imported media file has been handed to processing, and what
-- processing said.
--
-- An import puts a file in the library and stops; the library scan registers
-- it some minutes later, once the server's mount can see it. A sweep then
-- queues processing for each committed media file the scan has registered.
-- These columns are that sweep's memory, kept on the import file it was about:
--
-- processing_outcome: NULL while undecided. Otherwise queued, already-queued,
--   already-complete, rejected or gave-up. A decided file is never offered to
--   processing again by the sweep, so a title an operator cancelled stays
--   cancelled.
-- processing_attempts / processing_retry_at: transient refusals (an error, no
--   scratch space, a source the encoding machine cannot read yet), so a file
--   that keeps failing is probed with backoff and eventually left alone rather
--   than every half-minute forever.
-- processing_job_id: the processing job the sweep created, when it did.

ALTER TABLE import_files ADD COLUMN IF NOT EXISTS processing_outcome text;
ALTER TABLE import_files ADD COLUMN IF NOT EXISTS processing_detail text;
ALTER TABLE import_files
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE import_files ADD COLUMN IF NOT EXISTS processing_retry_at timestamptz;
ALTER TABLE import_files ADD COLUMN IF NOT EXISTS processing_job_id uuid
  REFERENCES processing_jobs(id) ON DELETE SET NULL;
ALTER TABLE import_files ADD COLUMN IF NOT EXISTS processing_decided_at timestamptz;

ALTER TABLE import_files ADD CONSTRAINT import_files_processing_outcome_known
  CHECK (
    processing_outcome IS NULL OR processing_outcome IN (
      'queued', 'already-queued', 'already-complete', 'rejected', 'gave-up'
    )
  );

-- The sweep asks for exactly this set, every half-minute.
CREATE INDEX IF NOT EXISTS import_files_processing_undecided_idx
  ON import_files (import_id)
  WHERE role = 'media' AND state = 'committed' AND processing_outcome IS NULL;
