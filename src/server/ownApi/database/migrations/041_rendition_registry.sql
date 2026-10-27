-- The rendition registry, moved out of media/.seyirlik/state/registry.json.
--
-- Two machines write the registry: the server removes titles from it, and the
-- encoding laptop adds every title it processes. Both reach the file through
-- their own rclone mount of the same Google Drive folder, and a file written
-- through two independent mounts loses writes: on 2026-10-20 one save left a
-- 0-byte object that failed every encode, and two later saves never reached
-- Drive at all. Both machines already share this database.
--
-- One row holds the whole document, validated by the application on every
-- read and write. Writers change it with SELECT ... FOR UPDATE, so an update
-- always applies to the current registry and never to a copy loaded earlier.
-- `revision` lets a reader tell whether it changed without reading it.
--
-- The row is created by `scripts/rendition-registry.ts import`, or on first
-- use from the old file when that was not run. The file itself is left where
-- it was and is no longer read once the row exists.

CREATE TABLE IF NOT EXISTS rendition_registry (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  document jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  imported_from text
);
