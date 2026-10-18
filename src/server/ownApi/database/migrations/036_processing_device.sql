-- Which machine ran a processing attempt. Encodes moved off the server to a
-- laptop that is switched on by hand, and the page has to be able to say
-- where a job is running: the hardware columns alone name an encoder, and
-- before a worker plans the attempt they hold the server's queue-time guess.
--
-- Written by the worker when it plans an attempt and cleared when the next
-- attempt begins. NULL: not planned yet, or planned by a release that did not
-- record it.

ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS processed_by text;
