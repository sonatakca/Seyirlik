-- An imported file's upload to Google Drive.
--
-- The helper machine imports into a Google Drive mount, which uploads the file
-- in the background after the import has already completed. Until it is on
-- Drive the server cannot see it, so the title stays missing and nothing is
-- processed. This is that upload's progress, written by the machine doing it,
-- in the same shape as processing_jobs.drive_upload. NULL where nothing is
-- uploaded after an import.

ALTER TABLE import_files ADD COLUMN IF NOT EXISTS drive_upload jsonb;
