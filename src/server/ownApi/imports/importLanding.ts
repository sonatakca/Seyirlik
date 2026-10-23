/** Whether an import still stands for media on its way into the library.
 *
 * An import finishes once its files are in the library, but the library scan
 * registers them minutes later — on a cloud mount only once the upload is
 * visible to the server. In between, the episode has no media file, its
 * download is finished and its import is complete, so every "is it coming?"
 * check used to answer no, and a missing-episode search downloaded the same
 * release again.
 *
 * The processing sweep already knows the difference: it leaves a committed
 * media file undecided until the scan has registered it. A complete import
 * with such a file is still landing. The window bounds it for a library where
 * the sweep is switched off and nothing ever decides. It is a day, like the
 * wait a finished download gets before its import: a large file can queue
 * behind others on its way up to the cloud for hours.
 * Aliases here are code-owned SQL identifiers, never request input.
 */
export const IMPORT_LANDING_WINDOW = "1 day";

export function importUnderWaySql(alias: string): string {
  return `(${alias}.state NOT IN ('complete', 'cancelled', 'failed')
    OR (${alias}.state = 'complete'
      AND COALESCE(${alias}.committed_at, ${alias}.completed_at) > now() - interval '${IMPORT_LANDING_WINDOW}'
      AND EXISTS (SELECT 1 FROM import_files landing_file
        WHERE landing_file.import_id = ${alias}.id AND landing_file.role = 'media'
          AND landing_file.state = 'committed' AND landing_file.processing_outcome IS NULL)))`;
}
