-- What a processing attempt leaves behind once its live sample is gone.
--
-- phase_history: one summary per finished build phase (planning, video,
-- audio, subtitles, assembly, verification, publication), written as each
-- phase closes. The live sample carried these only while the job ran, so a
-- finished card showed nothing but the video encode.
--
-- drive_upload: the helper machine publishes into a Google Drive mount whose
-- uploads continue in the background after the job has succeeded. This is that
-- upload's progress, written by the machine doing it, until the files are on
-- Drive. NULL where nothing is uploaded after publication.
--
-- Both describe an attempt and are cleared when the next one begins.

ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS phase_history jsonb;
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS drive_upload jsonb;
