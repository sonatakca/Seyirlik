/** Catalogue truth shared by browse queries and the administrator's status list.
 * A wanted metadata row is not a playable item. Groups need an available child.
 *
 * Available means a file row the last scan found on disk: present, non-empty
 * and not rejected by the prober. A title whose source was replaced by its
 * package keeps its row in that state (probe_state `packaged`), because the
 * scanner only keeps it alive after proving the package complete. How a
 * processing job ended is deliberately not consulted: a succeeded job says
 * nothing about whether the files are still there — on a cloud mount they may
 * never have finished uploading — and a failed one says nothing about a
 * package that is sitting complete on disk.
 * Aliases here are code-owned SQL identifiers, never request input.
 */
export function mediaAvailableSql(alias = "item"): string {
  return `EXISTS (SELECT 1 FROM items available_item
    WHERE (available_item.id = ${alias}.id OR available_item.series_id = ${alias}.id OR available_item.parent_id = ${alias}.id
      OR available_item.id IN (SELECT member.item_id FROM collection_members member WHERE member.collection_id = ${alias}.id))
      AND EXISTS (SELECT 1 FROM media_files available_file WHERE available_file.item_id = available_item.id
          AND available_file.missing_since IS NULL AND available_file.size_bytes > 0
          AND available_file.probe_state <> 'failed'))`;
}

export const MEDIA_STATUS_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM processing_jobs p WHERE p.item_id = item.id AND p.state = 'succeeded' AND p.published_version IS NOT NULL) THEN 'ready'
  WHEN EXISTS (SELECT 1 FROM processing_jobs p WHERE p.item_id = item.id AND p.state = 'paused') THEN 'paused'
  WHEN EXISTS (SELECT 1 FROM processing_jobs p WHERE p.item_id = item.id AND p.state IN ('running', 'queued', 'pending')) THEN 'processing'
  WHEN ${mediaAvailableSql()} THEN 'downloaded'
  WHEN EXISTS (SELECT 1 FROM acquisitions a WHERE a.target_item_id = item.id AND a.state NOT IN ('downloaded', 'cancelled', 'superseded', 'failed')) THEN 'downloading'
  WHEN EXISTS (SELECT 1 FROM acquisitions a WHERE a.target_item_id = item.id AND a.state = 'downloaded') THEN 'awaiting-import'
  WHEN item.desired THEN 'wanted'
  ELSE 'missing' END`;
